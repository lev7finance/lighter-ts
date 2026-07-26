// Command oracle emits cross-language conformance vectors for the lighter-ts SDK.
//
// It uses the upstream Go implementation (github.com/elliottech/lighter-go and
// github.com/elliottech/poseidon_crypto) purely as a reference oracle: it feeds
// deterministic inputs through the reference and records the outputs as JSON.
// The TypeScript implementation is written independently and must reproduce
// these outputs bit-for-bit.
//
// Nothing here is imported by the SDK. It is a build-time test-fixture generator.
//
// Usage:
//
//	go run . -out ../vectors
package main

import (
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"math/big"
	"os"
	"path/filepath"

	curve "github.com/elliottech/poseidon_crypto/curve/ecgfp5"
	g "github.com/elliottech/poseidon_crypto/field/goldilocks"
	gFp5 "github.com/elliottech/poseidon_crypto/field/goldilocks_quintic_extension"
	p2 "github.com/elliottech/poseidon_crypto/hash/poseidon2_goldilocks_plonky2"
	schnorr "github.com/elliottech/poseidon_crypto/signature/schnorr"

	"github.com/elliottech/lighter-go/types/txtypes"
	"github.com/ethereum/go-ethereum/accounts"
)

// ---------------------------------------------------------------------------
// deterministic input generation (splitmix64) — no randomness, fully reproducible
// ---------------------------------------------------------------------------

type rng struct{ state uint64 }

func newRNG(seed uint64) *rng { return &rng{state: seed} }

func (r *rng) next() uint64 {
	r.state += 0x9e3779b97f4a7c15
	z := r.state
	z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
	z = (z ^ (z >> 27)) * 0x94d049bb133111eb
	return z ^ (z >> 31)
}

// nextCanonical returns a uniformly-ish distributed value in [0, ORDER).
func (r *rng) nextCanonical() uint64 { return r.next() % g.ORDER }

func (r *rng) nextF() g.GoldilocksField { return g.GoldilocksField(r.nextCanonical()) }

func (r *rng) nextFp5() gFp5.Element {
	return gFp5.Element{r.nextF(), r.nextF(), r.nextF(), r.nextF(), r.nextF()}
}

// ---------------------------------------------------------------------------
// encoding helpers — every value crosses the boundary as a decimal string or hex,
// never as a JSON number, so JS cannot silently lose precision.
// ---------------------------------------------------------------------------

func u64s(v uint64) string { return fmt.Sprintf("%d", v) }

// l1Hex mirrors the reference's argument formatting for L1 message templates:
// a 0x prefix followed by exactly 16 zero-padded lowercase hex digits.
func l1Hex(v uint64) string { return fmt.Sprintf("0x%016x", v) }

// fStr emits the CANONICAL value of a field element.
//
// This is deliberate and load-bearing. The Go reference stores GoldilocksField
// as a raw uint64 in *non-canonical* form: arithmetic results are only reduced
// into [0, 2^64) and may sit up to one ORDER above the canonical residue.
// ToCanonicalUint64 performs the final conditional subtraction, and every
// serialization path (ToLittleEndianBytesF) applies it.
//
// That representation is a hardware-64-bit micro-optimization with no analogue
// in a BigInt implementation. lighter-ts reduces fully on every operation, so
// vectors are recorded canonically and both implementations agree. The raw
// non-canonical behaviour is documented separately in goldilocks.json under
// "nonCanonicalNotes" so the divergence is explicit rather than accidental.
func fStr(f g.GoldilocksField) string { return u64s(f.ToCanonicalUint64()) }

// fStrRaw emits the reference's internal, possibly non-canonical, uint64.
func fStrRaw(f g.GoldilocksField) string { return u64s(uint64(f)) }

func fp5Strs(e gFp5.Element) []string {
	out := make([]string, 5)
	for i, c := range e {
		out[i] = fStr(c)
	}
	return out
}

func fp5Hex(e gFp5.Element) string { return hex.EncodeToString(e.ToLittleEndianBytes()) }

func fsStrs(in []g.GoldilocksField) []string {
	out := make([]string, len(in))
	for i, f := range in {
		out[i] = fStr(f)
	}
	return out
}

func scalarStrs(s curve.ECgFp5Scalar) []string {
	out := make([]string, 5)
	for i, limb := range s {
		out[i] = u64s(limb)
	}
	return out
}

func scalarHex(s curve.ECgFp5Scalar) string {
	return hex.EncodeToString(s.ToLittleEndianBytes())
}

// ---------------------------------------------------------------------------
// vector groups
// ---------------------------------------------------------------------------

type goldilocksVectors struct {
	Order             string               `json:"order"`
	Epsilon           string               `json:"epsilon"`
	TwoAdicity        int                  `json:"twoAdicity"`
	PowerOfTwoGen     string               `json:"powerOfTwoGenerator"`
	Cases             []goldilocksCase     `json:"cases"`
	Encoding          []goldilocksEncoding `json:"encoding"`
	NonCanonicalNotes nonCanonicalNotes    `json:"nonCanonicalNotes"`
}

// nonCanonicalNotes documents the one place the reference's internal
// representation diverges from a straightforward BigInt implementation.
// Every "expected" value elsewhere in these vectors is canonical; this section
// exists so that divergence is a recorded decision, not a latent bug.
type nonCanonicalNotes struct {
	Explanation string                `json:"explanation"`
	Examples    []nonCanonicalExample `json:"examples"`
}

type nonCanonicalExample struct {
	Op        string `json:"op"`
	A         string `json:"a"`
	B         string `json:"b"`
	Raw       string `json:"raw"`       // reference's internal uint64
	Canonical string `json:"canonical"` // what lighter-ts must produce
	LEHex     string `json:"leBytesHex"`
}

type goldilocksCase struct {
	A       string  `json:"a"`
	B       string  `json:"b"`
	Add     string  `json:"add"`
	Sub     string  `json:"sub"`
	Mul     string  `json:"mul"`
	SquareA string  `json:"squareA"`
	DoubleA string  `json:"doubleA"`
	NegA    string  `json:"negA"`
	Exp     string  `json:"exp"`     // a^b
	ExpPow2 string  `json:"expPow2"` // a^(2^7)
	IsQRA   bool    `json:"isQuadraticResidueA"`
	SqrtA   *string `json:"sqrtA"` // nil when a is not a QR
}

type goldilocksEncoding struct {
	Value      string `json:"value"`
	LEBytesHex string `json:"leBytesHex"`
}

type fp5Vectors struct {
	Bytes int       `json:"bytes"`
	Cases []fp5Case `json:"cases"`
}

type fp5Case struct {
	A           []string `json:"a"`
	B           []string `json:"b"`
	Add         []string `json:"add"`
	Sub         []string `json:"sub"`
	Mul         []string `json:"mul"`
	SquareA     []string `json:"squareA"`
	DoubleA     []string `json:"doubleA"`
	TripleA     []string `json:"tripleA"`
	NegA        []string `json:"negA"`
	InverseA    []string `json:"inverseA"`
	DivAB       []string `json:"divAB"`
	FrobeniusA  []string `json:"frobeniusA"`
	Frobenius2A []string `json:"frobenius2A"`
	ScalarMulA  []string `json:"scalarMulA"` // a * b[0] (base-field scalar)
	LegendreA   string   `json:"legendreA"`
	Sgn0A       bool     `json:"sgn0A"`
	SqrtA       []string `json:"sqrtA"` // zero-filled when !sqrtAExists
	SqrtAExists bool     `json:"sqrtAExists"`
	CanonSqrtA  []string `json:"canonicalSqrtA"` // zero-filled when !canonicalSqrtAExists
	CanonExists bool     `json:"canonicalSqrtAExists"`
	ALEBytesHex string   `json:"aLeBytesHex"`
}

// poseidon2Constants is the full parameter set of the permutation, dumped
// mechanically. Transcribing 8x12 external constants, 22 internal constants and
// a 12-element diagonal by hand is a guaranteed source of a silent one-digit
// error, so the TypeScript constants module is generated from this file.
type poseidon2Constants struct {
	Width             int        `json:"width"`
	Rate              int        `json:"rate"`
	Out               int        `json:"out"`
	SBoxDegree        int        `json:"sboxDegree"`
	RoundsF           int        `json:"roundsF"`
	RoundsFHalf       int        `json:"roundsFHalf"`
	RoundsP           int        `json:"roundsP"`
	ExternalConstants [][]string `json:"externalConstants"`
	InternalConstants []string   `json:"internalConstants"`
	MatrixDiag12      []string   `json:"matrixDiag12"`
}

type poseidonVectors struct {
	Constants     poseidon2Constants `json:"constants"`
	Width         int                `json:"width"`
	Permutations  []permutationCase  `json:"permutations"`
	HashToFp5     []hashToFp5Case    `json:"hashToQuinticExtension"`
	HashNoPad     []hashNoPadCase    `json:"hashNoPad"`
	HashNToMNoPad []hashNToMCase     `json:"hashNToMNoPad"`
}

type permutationCase struct {
	Input  []string `json:"input"`
	Output []string `json:"output"`
}

type hashToFp5Case struct {
	Input     []string `json:"input"`
	Output    []string `json:"output"`
	OutputHex string   `json:"outputLeBytesHex"`
}

type hashNoPadCase struct {
	Input  []string `json:"input"`
	Output []string `json:"output"` // HashOut = 4 goldilocks elements
}

type hashNToMCase struct {
	Input      []string `json:"input"`
	NumOutputs int      `json:"numOutputs"`
	Output     []string `json:"output"`
}

type curveVectors struct {
	GeneratorEncoded []string     `json:"generatorEncoded"`
	NeutralEncoded   []string     `json:"neutralEncoded"`
	Cases            []curveCase  `json:"cases"`
	ScalarCases      []scalarCase `json:"scalarCases"`
}

type curveCase struct {
	ScalarLEHex     string   `json:"scalarLeHex"`
	Scalar          []string `json:"scalar"`
	MulGenEncoded   []string `json:"mulGenEncoded"` // [scalar]G, encoded to Fp5
	MulGenHex       string   `json:"mulGenLeBytesHex"`
	DoubleEncoded   []string `json:"doubleEncoded"` // [2*scalar]G
	AddGenEncoded   []string `json:"addGenEncoded"` // [scalar]G + G
	DecodeRoundTrip bool     `json:"decodeRoundTrip"`
}

type scalarCase struct {
	InputLEHex string   `json:"inputLeHex"`
	Scalar     []string `json:"scalar"`
	// InputInRange is the interesting bit: whether the raw 40 bytes were already
	// below the group order, i.e. whether decoding had to reduce. (Asking whether
	// the DECODED scalar is canonical is tautological — the decoder always
	// reduces, so it is true on every row and carries no information.)
	InputInRange bool `json:"inputWasInRange"`
	// Reduced records that decoding changed the value.
	Reduced     bool   `json:"wasReduced"`
	OutputLEHex string `json:"outputLeHex"`
}

type schnorrVectors struct {
	SignatureBytes int              `json:"signatureBytes"`
	PubKeyBytes    int              `json:"pubKeyBytes"`
	Cases          []schnorrCase    `json:"cases"`
	Negative       []schnorrNegCase `json:"negative"`
}

type schnorrCase struct {
	PrivateKeyLEHex string   `json:"privateKeyLeHex"`
	PublicKey       []string `json:"publicKey"`
	PublicKeyLEHex  string   `json:"publicKeyLeHex"`
	MessageElems    []string `json:"messageElements"`
	HashedMsg       []string `json:"hashedMessage"`
	HashedMsgLEHex  string   `json:"hashedMessageLeHex"`
	NonceKLEHex     string   `json:"nonceKLeHex"`
	SigS            []string `json:"sigS"`
	SigE            []string `json:"sigE"`
	SigBytesHex     string   `json:"signatureBytesHex"`
	Valid           bool     `json:"valid"`
	Canonical       bool     `json:"canonical"`
}

type schnorrNegCase struct {
	Description    string `json:"description"`
	PublicKeyLEHex string `json:"publicKeyLeHex"`
	HashedMsgLEHex string `json:"hashedMessageLeHex"`
	SignatureHex   string `json:"signatureHex"`
	Valid          bool   `json:"valid"`
}

type txVectors struct {
	ChainID    uint32          `json:"chainId"`
	Attributes []attrCase      `json:"attributeHashes"`
	Txs        []txHashCase    `json:"txHashes"`
	L1Messages []l1MessageCase `json:"l1Messages"`
	AuthTokens []authTokenCase `json:"authTokens"`
}

type attrCase struct {
	Attributes    map[string]int `json:"attributes"`
	IsEmpty       bool           `json:"isEmpty"`
	AttrHash      []string       `json:"attributesHash"`
	InputTxHash   []string       `json:"inputTxHash"`
	AggregatedHex string         `json:"aggregatedLeBytesHex"`
}

type txHashCase struct {
	Name        string            `json:"name"`
	TxType      uint8             `json:"txType"`
	Fields      map[string]string `json:"fields"`
	Attributes  map[string]int    `json:"attributes"`
	MsgHashHex  string            `json:"messageHashLeHex"`
	SigBytesHex string            `json:"signatureBytesHex"`
	NonceKLEHex string            `json:"nonceKLeHex"`
	TxInfoJSON  string            `json:"txInfoJson"`
}

// authTokenCase pins the read-only auth token used for authenticated REST reads.
//
// The token is  "<deadlineUnixSeconds>:<accountIndex>:<apiKeyIndex>:<hexSignature>"  where the
// signature covers a Poseidon2 hash of the message text packed into field elements, 8 bytes per
// element, little-endian, with the final partial chunk zero-padded to 8.
type authTokenCase struct {
	Deadline     string   `json:"deadline"`
	AccountIndex string   `json:"accountIndex"`
	ApiKeyIndex  string   `json:"apiKeyIndex"`
	Message      string   `json:"message"`
	MessageHex   string   `json:"messageUtf8Hex"`
	PackedElems  []string `json:"packedFieldElements"`
	MsgHashHex   string   `json:"messageHashLeHex"`
	NonceKLEHex  string   `json:"nonceKLeHex"`
	SigBytesHex  string   `json:"signatureBytesHex"`
	Token        string   `json:"token"`
}

// l1MessageCase pins an EIP-191 "personal_sign" message body exactly as the
// protocol expects it. The formatting is unforgiving: every numeric argument is
// rendered as a 16-hex-digit, zero-padded, 0x-prefixed string, and the memo is
// the raw 32-byte field hex-encoded. A single missing pad character produces a
// different signed message and therefore a rejected registration or transfer.
type l1MessageCase struct {
	Name       string            `json:"name"`
	Fields     map[string]string `json:"fields"`
	Body       string            `json:"body"`
	BodyHex    string            `json:"bodyUtf8Hex"`
	EIP191Hash string            `json:"eip191HashHex"`
}

// ---------------------------------------------------------------------------

func buildGoldilocks(r *rng) goldilocksVectors {
	v := goldilocksVectors{
		Order:         u64s(g.ORDER),
		Epsilon:       u64s(g.EPSILON),
		TwoAdicity:    g.TWO_ADICITY,
		PowerOfTwoGen: fStr(g.POWER_OF_TWO_GENERATOR),
	}

	// Edge cases first, then deterministic pseudo-random pairs.
	edges := []uint64{
		0, 1, 2,
		g.ORDER - 1, g.ORDER - 2,
		g.EPSILON, g.EPSILON + 1, g.EPSILON - 1,
		1 << 31, 1 << 32, (1 << 32) + 1,
		1 << 63,
		0xffffffff00000000,
		0xfffffffe00000001, // -1 doubled region
	}

	pairs := make([][2]uint64, 0, 64)
	for i := 0; i < len(edges); i++ {
		for j := 0; j < len(edges); j += 3 {
			pairs = append(pairs, [2]uint64{edges[i], edges[j]})
		}
	}
	for i := 0; i < 48; i++ {
		pairs = append(pairs, [2]uint64{r.nextCanonical(), r.nextCanonical()})
	}

	for _, p := range pairs {
		a := g.GoldilocksField(p[0] % g.ORDER)
		b := g.GoldilocksField(p[1] % g.ORDER)

		c := goldilocksCase{
			A:       fStr(a),
			B:       fStr(b),
			Add:     fStr(g.AddF(a, b)),
			Sub:     fStr(g.SubF(a, b)),
			Mul:     fStr(g.MulF(a, b)),
			SquareA: fStr(g.SquareF(a)),
			DoubleA: fStr(g.DoubleF(a)),
			NegA:    fStr(g.NegF(a)),
			Exp:     fStr(g.ExpF(a, uint64(b))),
			ExpPow2: fStr(g.ExpPowerOf2(a, 7)),
			IsQRA:   g.IsQuadraticResidueF(a),
		}
		if s := g.SqrtF(a); s != nil {
			str := fStr(*s)
			c.SqrtA = &str
		}
		v.Cases = append(v.Cases, c)
	}

	for _, e := range edges {
		val := g.GoldilocksField(e % g.ORDER)
		v.Encoding = append(v.Encoding, goldilocksEncoding{
			Value:      fStr(val),
			LEBytesHex: hex.EncodeToString(g.ToLittleEndianBytesF(val)),
		})
	}

	v.NonCanonicalNotes = nonCanonicalNotes{
		Explanation: "The Go reference stores a field element as a raw uint64 that is only partially " +
			"reduced: after AddF/SubF/MulF the stored value may exceed ORDER by up to EPSILON-ish, and " +
			"ToCanonicalUint64 applies the final conditional subtraction. FromCanonicalLittleEndianBytesF " +
			"performs NO range validation, so a limb >= ORDER decodes to a non-canonical element rather " +
			"than an error. lighter-ts reduces fully on every operation; all 'expected' values in these " +
			"vector files are canonical. The examples below are the cases where the reference's internal " +
			"uint64 differs from the canonical residue — they must NOT be reproduced by lighter-ts.",
	}

	// Surface concrete raw-vs-canonical divergences so the difference is provable.
	probe := []struct {
		op   string
		a, b g.GoldilocksField
		out  g.GoldilocksField
	}{}
	for _, pair := range [][2]uint64{
		{g.ORDER - 1, 1},
		{g.ORDER - 1, 2},
		{g.ORDER - 1, g.ORDER - 1},
		{1, 2},
		{g.EPSILON, g.EPSILON},
	} {
		a := g.GoldilocksField(pair[0])
		b := g.GoldilocksField(pair[1])
		probe = append(probe,
			struct {
				op   string
				a, b g.GoldilocksField
				out  g.GoldilocksField
			}{"add", a, b, g.AddF(a, b)},
			struct {
				op   string
				a, b g.GoldilocksField
				out  g.GoldilocksField
			}{"sub", a, b, g.SubF(a, b)},
			struct {
				op   string
				a, b g.GoldilocksField
				out  g.GoldilocksField
			}{"mul", a, b, g.MulF(a, b)},
		)
	}
	for _, p := range probe {
		if uint64(p.out) == p.out.ToCanonicalUint64() {
			continue // only record actual divergences
		}
		v.NonCanonicalNotes.Examples = append(v.NonCanonicalNotes.Examples, nonCanonicalExample{
			Op:        p.op,
			A:         fStr(p.a),
			B:         fStr(p.b),
			Raw:       fStrRaw(p.out),
			Canonical: fStr(p.out),
			LEHex:     hex.EncodeToString(g.ToLittleEndianBytesF(p.out)),
		})
	}

	return v
}

func buildFp5(r *rng) fp5Vectors {
	v := fp5Vectors{Bytes: gFp5.Bytes}

	zero := gFp5.Element{}
	one := gFp5.FromUint64(1)

	fixed := [][2]gFp5.Element{
		{zero, one},
		{one, one},
		{one, zero},
		{gFp5.FromUint64(2), gFp5.FromUint64(3)},
		{gFp5.Element{1, 2, 3, 4, 5}, gFp5.Element{6, 7, 8, 9, 10}},
		{
			gFp5.Element{g.GoldilocksField(g.ORDER - 1), 0, 0, 0, 1},
			gFp5.Element{0, g.GoldilocksField(g.ORDER - 1), 1, 0, 0},
		},
	}

	pairs := append([][2]gFp5.Element{}, fixed...)
	for i := 0; i < 40; i++ {
		pairs = append(pairs, [2]gFp5.Element{r.nextFp5(), r.nextFp5()})
	}

	for _, p := range pairs {
		a, b := p[0], p[1]

		c := fp5Case{
			A:           fp5Strs(a),
			B:           fp5Strs(b),
			Add:         fp5Strs(gFp5.Add(a, b)),
			Sub:         fp5Strs(gFp5.Sub(a, b)),
			Mul:         fp5Strs(gFp5.Mul(a, b)),
			SquareA:     fp5Strs(gFp5.Square(a)),
			DoubleA:     fp5Strs(gFp5.Double(a)),
			TripleA:     fp5Strs(gFp5.Triple(a)),
			NegA:        fp5Strs(gFp5.Neg(a)),
			InverseA:    fp5Strs(gFp5.InverseOrZero(a)),
			FrobeniusA:  fp5Strs(gFp5.Frobenius(a)),
			Frobenius2A: fp5Strs(gFp5.RepeatedFrobenius(a, 2)),
			ScalarMulA:  fp5Strs(gFp5.ScalarMul(a, b[0])),
			LegendreA:   fStr(gFp5.Legendre(a)),
			Sgn0A:       gFp5.Sgn0(a),
			ALEBytesHex: fp5Hex(a),
		}
		if gFp5.IsZero(b) {
			c.DivAB = fp5Strs(zero)
		} else {
			c.DivAB = fp5Strs(gFp5.Div(a, b))
		}
		if s, ok := gFp5.Sqrt(a); ok {
			c.SqrtA, c.SqrtAExists = fp5Strs(s), true
		} else {
			c.SqrtA, c.SqrtAExists = fp5Strs(zero), false
		}
		if s, ok := gFp5.CanonicalSqrt(a); ok {
			c.CanonSqrtA, c.CanonExists = fp5Strs(s), true
		} else {
			c.CanonSqrtA, c.CanonExists = fp5Strs(zero), false
		}

		v.Cases = append(v.Cases, c)
	}

	return v
}

func buildPoseidon(r *rng) poseidonVectors {
	v := poseidonVectors{Width: p2.WIDTH}

	ext := make([][]string, p2.ROUNDS_F)
	for r := 0; r < p2.ROUNDS_F; r++ {
		row := make([]string, p2.WIDTH)
		for i := 0; i < p2.WIDTH; i++ {
			row[i] = fStr(p2.EXTERNAL_CONSTANTS[r][i])
		}
		ext[r] = row
	}
	internal := make([]string, p2.ROUNDS_P)
	for r := 0; r < p2.ROUNDS_P; r++ {
		internal[r] = fStr(p2.INTERNAL_CONSTANTS[r])
	}
	diag := make([]string, p2.WIDTH)
	for i := 0; i < p2.WIDTH; i++ {
		diag[i] = fStr(p2.MATRIX_DIAG_12_U64[i])
	}
	v.Constants = poseidon2Constants{
		Width: p2.WIDTH, Rate: p2.RATE, Out: p2.OUT, SBoxDegree: p2.D,
		RoundsF: p2.ROUNDS_F, RoundsFHalf: p2.ROUNDS_F_HALF, RoundsP: p2.ROUNDS_P,
		ExternalConstants: ext, InternalConstants: internal, MatrixDiag12: diag,
	}

	// Permutation: all-zero state, counting state, then pseudo-random states.
	states := make([][p2.WIDTH]g.GoldilocksField, 0, 24)

	var zeroState [p2.WIDTH]g.GoldilocksField
	states = append(states, zeroState)

	var counting [p2.WIDTH]g.GoldilocksField
	for i := range counting {
		counting[i] = g.GoldilocksField(i)
	}
	states = append(states, counting)

	var maxState [p2.WIDTH]g.GoldilocksField
	for i := range maxState {
		maxState[i] = g.GoldilocksField(g.ORDER - 1)
	}
	states = append(states, maxState)

	for i := 0; i < 20; i++ {
		var s [p2.WIDTH]g.GoldilocksField
		for j := range s {
			s[j] = r.nextF()
		}
		states = append(states, s)
	}

	for _, s := range states {
		in := s
		out := s
		p2.Permute(&out)
		v.Permutations = append(v.Permutations, permutationCase{
			Input:  fsStrs(in[:]),
			Output: fsStrs(out[:]),
		})
	}

	// HashToQuinticExtension across every input length the tx layer can produce
	// (tx hashes use up to ~20 elements; attribute hashes use up to 8).
	for n := 0; n <= 24; n++ {
		in := make([]g.GoldilocksField, n)
		for i := range in {
			in[i] = r.nextF()
		}
		out := p2.HashToQuinticExtension(in)
		v.HashToFp5 = append(v.HashToFp5, hashToFp5Case{
			Input:     fsStrs(in),
			Output:    fp5Strs(out),
			OutputHex: fp5Hex(out),
		})
	}

	// Small-value inputs matter too: tx hashes are mostly tiny integers.
	for n := 1; n <= 20; n++ {
		in := make([]g.GoldilocksField, n)
		for i := range in {
			in[i] = g.GoldilocksField(i + 1)
		}
		out := p2.HashToQuinticExtension(in)
		v.HashToFp5 = append(v.HashToFp5, hashToFp5Case{
			Input:     fsStrs(in),
			Output:    fp5Strs(out),
			OutputHex: fp5Hex(out),
		})
	}

	for n := 0; n <= 16; n++ {
		in := make([]g.GoldilocksField, n)
		for i := range in {
			in[i] = r.nextF()
		}
		out := p2.HashNoPad(in)
		v.HashNoPad = append(v.HashNoPad, hashNoPadCase{
			Input:  fsStrs(in),
			Output: fsStrs(out[:]),
		})
	}

	for _, n := range []int{1, 4, 8, 12} {
		for _, m := range []int{1, 4, 5, 8} {
			in := make([]g.GoldilocksField, n)
			for i := range in {
				in[i] = r.nextF()
			}
			out := p2.HashNToMNoPad(in, m)
			v.HashNToMNoPad = append(v.HashNToMNoPad, hashNToMCase{
				Input:      fsStrs(in),
				NumOutputs: m,
				Output:     fsStrs(out),
			})
		}
	}

	return v
}

func buildCurve(r *rng) curveVectors {
	gen := curve.GENERATOR_WEIERSTRASS
	neutral := curve.NEUTRAL_WEIERSTRASS

	v := curveVectors{
		GeneratorEncoded: fp5Strs(gen.Encode()),
		NeutralEncoded:   fp5Strs(neutral.Encode()),
	}

	scalars := make([]curve.ECgFp5Scalar, 0, 24)
	scalars = append(scalars,
		curve.ECgFp5Scalar{1, 0, 0, 0, 0},
		curve.ECgFp5Scalar{2, 0, 0, 0, 0},
		curve.ECgFp5Scalar{3, 0, 0, 0, 0},
		curve.ECgFp5Scalar{0xffffffffffffffff, 0, 0, 0, 0},
	)
	for i := 0; i < 16; i++ {
		var s curve.ECgFp5Scalar
		for j := range s {
			s[j] = r.next()
		}
		// keep it in range by round-tripping through the canonical decoder
		scalars = append(scalars, curve.ScalarElementFromLittleEndianBytes(s.ToLittleEndianBytes()))
	}

	two := curve.ECgFp5Scalar{2, 0, 0, 0, 0}
	one := curve.ECgFp5Scalar{1, 0, 0, 0, 0}
	zero := curve.ECgFp5Scalar{}

	for _, s := range scalars {
		// [s]G  == MulAdd2(G, NEUTRAL, s, 0)
		pt := curve.MulAdd2(gen, neutral, s, zero)
		dbl := curve.MulAdd2(gen, neutral, s.Mul(two), zero)
		addG := curve.MulAdd2(gen, gen, s, one)

		enc := pt.Encode()
		_, ok := curve.DecodeFp5AsWeierstrass(enc)

		v.Cases = append(v.Cases, curveCase{
			ScalarLEHex:     scalarHex(s),
			Scalar:          scalarStrs(s),
			MulGenEncoded:   fp5Strs(enc),
			MulGenHex:       fp5Hex(enc),
			DoubleEncoded:   fp5Strs(dbl.Encode()),
			AddGenEncoded:   fp5Strs(addG.Encode()),
			DecodeRoundTrip: ok,
		})
	}

	// Scalar decoding: canonical, non-canonical, and all-ones input.
	rawInputs := [][]byte{
		make([]byte, 40),
		append([]byte{1}, make([]byte, 39)...),
	}
	allOnes := make([]byte, 40)
	for i := range allOnes {
		allOnes[i] = 0xff
	}
	rawInputs = append(rawInputs, allOnes)
	for i := 0; i < 8; i++ {
		b := make([]byte, 40)
		for j := 0; j < 5; j++ {
			w := r.next()
			for k := 0; k < 8; k++ {
				b[j*8+k] = byte(w >> (8 * k))
			}
		}
		rawInputs = append(rawInputs, b)
	}

	for _, in := range rawInputs {
		s := curve.ScalarElementFromLittleEndianBytes(in)
		// Interpret the raw bytes as a little-endian 320-bit integer and compare
		// against the group order, so the vector records whether the DECODER had
		// work to do rather than restating that its output is canonical.
		raw := new(big.Int)
		for i := len(in) - 1; i >= 0; i-- {
			raw.Lsh(raw, 8)
			raw.Or(raw, big.NewInt(int64(in[i])))
		}
		inRange := raw.Cmp(curve.ORDER) < 0
		v.ScalarCases = append(v.ScalarCases, scalarCase{
			InputLEHex:   hex.EncodeToString(in),
			Scalar:       scalarStrs(s),
			InputInRange: inRange,
			Reduced:      !inRange,
			OutputLEHex:  scalarHex(s),
		})
	}

	return v
}

func buildSchnorr(r *rng) schnorrVectors {
	v := schnorrVectors{
		SignatureBytes: txtypes.SignatureLength,
		PubKeyBytes:    txtypes.PubKeyLength,
	}

	for i := 0; i < 16; i++ {
		skBytes := make([]byte, 40)
		for j := 0; j < 5; j++ {
			w := r.next()
			for k := 0; k < 8; k++ {
				skBytes[j*8+k] = byte(w >> (8 * k))
			}
		}
		sk := curve.ScalarElementFromLittleEndianBytes(skBytes)
		pk := schnorr.SchnorrPkFromSk(sk)

		// Message: a small field-element vector, hashed the way the tx layer hashes.
		msgLen := 4 + (i % 12)
		msg := make([]g.GoldilocksField, msgLen)
		for j := range msg {
			msg[j] = r.nextF()
		}
		hashed := p2.HashToQuinticExtension(msg)

		// Deterministic nonce so the vector is reproducible. Production signing
		// samples k randomly; SchnorrSignHashedMessage2 lets us pin it.
		kBytes := make([]byte, 40)
		for j := 0; j < 5; j++ {
			w := r.next()
			for k := 0; k < 8; k++ {
				kBytes[j*8+k] = byte(w >> (8 * k))
			}
		}
		k := curve.ScalarElementFromLittleEndianBytes(kBytes)

		sig := schnorr.SchnorrSignHashedMessage2(hashed, sk, k)

		v.Cases = append(v.Cases, schnorrCase{
			PrivateKeyLEHex: scalarHex(sk),
			PublicKey:       fp5Strs(pk),
			PublicKeyLEHex:  fp5Hex(pk),
			MessageElems:    fsStrs(msg),
			HashedMsg:       fp5Strs(hashed),
			HashedMsgLEHex:  fp5Hex(hashed),
			NonceKLEHex:     scalarHex(k),
			SigS:            scalarStrs(sig.S),
			SigE:            scalarStrs(sig.E),
			SigBytesHex:     hex.EncodeToString(sig.ToBytes()),
			Valid:           schnorr.IsSchnorrSignatureValid(pk, hashed, sig),
			Canonical:       sig.IsCanonical(),
		})
	}

	// Negative cases — verification must reject these.
	base := v.Cases[0]
	tamperedSig, _ := hex.DecodeString(base.SigBytesHex)
	tamperedSig[0] ^= 0x01
	pkBytes, _ := hex.DecodeString(base.PublicKeyLEHex)
	msgBytes, _ := hex.DecodeString(base.HashedMsgLEHex)

	tamperedMsg := append([]byte(nil), msgBytes...)
	tamperedMsg[0] ^= 0x01

	origSig, _ := hex.DecodeString(base.SigBytesHex)

	negs := []struct {
		desc string
		pk   []byte
		msg  []byte
		sig  []byte
	}{
		{"signature byte flipped", pkBytes, msgBytes, tamperedSig},
		{"message byte flipped", pkBytes, tamperedMsg, origSig},
		{"wrong public key", func() []byte { b := append([]byte(nil), pkBytes...); b[0] ^= 0x01; return b }(), msgBytes, origSig},
	}

	for _, n := range negs {
		valid := schnorr.Validate(n.pk, n.msg, n.sig) == nil
		v.Negative = append(v.Negative, schnorrNegCase{
			Description:    n.desc,
			PublicKeyLEHex: hex.EncodeToString(n.pk),
			HashedMsgLEHex: hex.EncodeToString(n.msg),
			SignatureHex:   hex.EncodeToString(n.sig),
			Valid:          valid,
		})
	}

	return v
}

const oracleChainID uint32 = 304

func buildTx(r *rng) txVectors {
	v := txVectors{ChainID: oracleChainID}

	// --- attribute aggregation ------------------------------------------------
	attrSets := []txtypes.L2TxAttributes{
		{},
		{txtypes.AttributeTypeSkipTxNonce: 1},
		{txtypes.AttributeTypeIntegratorAccountIndex: 12345},
		{
			txtypes.AttributeTypeIntegratorAccountIndex: 777,
			txtypes.AttributeTypeIntegratorTakerFee:     1000,
			txtypes.AttributeTypeIntegratorMakerFee:     500,
		},
		{
			txtypes.AttributeTypeSelfTradeBehaviorMode: txtypes.SelfTradeBehaviorCancelBoth,
			txtypes.AttributeTypeSelfTradeEqualityMode: txtypes.SelfTradeEqualityMasterAccountIndex,
		},
		{txtypes.AttributeTypeCancelAllMarketIndex: 3},
	}

	for _, attrs := range attrSets {
		inputHash := p2.HashToQuinticExtension([]g.GoldilocksField{
			g.GoldilocksField(oracleChainID), 1, 2, 3, 4,
		})
		aggregated, err := attrs.AggregateTxHash(inputHash)
		if err != nil {
			panic(err)
		}
		attrHash, err := attrs.Hash()
		if err != nil {
			panic(err)
		}
		m := make(map[string]int, len(attrs))
		for k, val := range attrs {
			m[fmt.Sprintf("%d", k)] = val
		}
		v.Attributes = append(v.Attributes, attrCase{
			Attributes:    m,
			IsEmpty:       attrs.IsEmpty(),
			AttrHash:      fp5Strs(attrHash),
			InputTxHash:   fp5Strs(inputHash),
			AggregatedHex: hex.EncodeToString(aggregated),
		})
	}

	// --- signed transaction hashes -------------------------------------------
	skBytes := make([]byte, 40)
	for j := 0; j < 5; j++ {
		w := r.next()
		for k := 0; k < 8; k++ {
			skBytes[j*8+k] = byte(w >> (8 * k))
		}
	}
	sk := curve.ScalarElementFromLittleEndianBytes(skBytes)

	kBytes := make([]byte, 40)
	for j := 0; j < 5; j++ {
		w := r.next()
		for k := 0; k < 8; k++ {
			kBytes[j*8+k] = byte(w >> (8 * k))
		}
	}
	nonceK := curve.ScalarElementFromLittleEndianBytes(kBytes)

	sign := func(msgHash []byte) string {
		e, err := gFp5.FromCanonicalLittleEndianBytes(msgHash)
		if err != nil {
			panic(err)
		}
		return hex.EncodeToString(schnorr.SchnorrSignHashedMessage2(e, sk, nonceK).ToBytes())
	}

	emit := func(name string, txType uint8, fields map[string]string, attrs txtypes.L2TxAttributes, msgHash []byte) {
		m := make(map[string]int, len(attrs))
		for k, val := range attrs {
			m[fmt.Sprintf("%d", k)] = val
		}
		v.Txs = append(v.Txs, txHashCase{
			Name:        name,
			TxType:      txType,
			Fields:      fields,
			Attributes:  m,
			MsgHashHex:  hex.EncodeToString(msgHash),
			SigBytesHex: sign(msgHash),
			NonceKLEHex: scalarHex(nonceK),
		})
	}

	// L2CreateOrder — limit, market, stop-loss, and with attributes.
	orderVariants := []struct {
		name  string
		order txtypes.OrderInfo
		attrs txtypes.L2TxAttributes
	}{
		{
			name: "create_order/limit_gtt_buy",
			order: txtypes.OrderInfo{
				MarketIndex: 1, ClientOrderIndex: 100, BaseAmount: 1_000_000, Price: 250_000,
				IsAsk: 0, Type: txtypes.LimitOrder, TimeInForce: txtypes.GoodTillTime,
				ReduceOnly: 0, TriggerPrice: txtypes.NilOrderTriggerPrice, OrderExpiry: 1893456000000,
			},
			attrs: txtypes.L2TxAttributes{},
		},
		{
			name: "create_order/market_ioc_sell",
			order: txtypes.OrderInfo{
				MarketIndex: 0, ClientOrderIndex: 1, BaseAmount: 500, Price: 4_294_967_295,
				IsAsk: 1, Type: txtypes.MarketOrder, TimeInForce: txtypes.ImmediateOrCancel,
				ReduceOnly: 0, TriggerPrice: txtypes.NilOrderTriggerPrice, OrderExpiry: txtypes.NilOrderExpiry,
			},
			attrs: txtypes.L2TxAttributes{},
		},
		{
			name: "create_order/stop_loss_limit_reduce_only",
			order: txtypes.OrderInfo{
				MarketIndex: 2, ClientOrderIndex: 987654321, BaseAmount: 42, Price: 1,
				IsAsk: 1, Type: txtypes.StopLossLimitOrder, TimeInForce: txtypes.GoodTillTime,
				ReduceOnly: 1, TriggerPrice: 123456, OrderExpiry: 1893456000000,
			},
			attrs: txtypes.L2TxAttributes{},
		},
		{
			name: "create_order/spot_post_only",
			order: txtypes.OrderInfo{
				MarketIndex: txtypes.MinSpotMarketIndex, ClientOrderIndex: txtypes.NilClientOrderIndex,
				BaseAmount: 7_777_777, Price: 999_999, IsAsk: 0, Type: txtypes.LimitOrder,
				TimeInForce: txtypes.PostOnly, ReduceOnly: 0,
				TriggerPrice: txtypes.NilOrderTriggerPrice, OrderExpiry: 1893456000000,
			},
			attrs: txtypes.L2TxAttributes{},
		},
		{
			name: "create_order/with_integrator_attributes",
			order: txtypes.OrderInfo{
				MarketIndex: 1, ClientOrderIndex: 55, BaseAmount: 1000, Price: 2000,
				IsAsk: 0, Type: txtypes.LimitOrder, TimeInForce: txtypes.GoodTillTime,
				ReduceOnly: 0, TriggerPrice: txtypes.NilOrderTriggerPrice, OrderExpiry: 1893456000000,
			},
			attrs: txtypes.L2TxAttributes{
				txtypes.AttributeTypeIntegratorAccountIndex: 4242,
				txtypes.AttributeTypeIntegratorTakerFee:     250,
				txtypes.AttributeTypeIntegratorMakerFee:     100,
			},
		},
		{
			name: "create_order/with_skip_nonce",
			order: txtypes.OrderInfo{
				MarketIndex: 1, ClientOrderIndex: 56, BaseAmount: 1000, Price: 2000,
				IsAsk: 1, Type: txtypes.LimitOrder, TimeInForce: txtypes.GoodTillTime,
				ReduceOnly: 0, TriggerPrice: txtypes.NilOrderTriggerPrice, OrderExpiry: 1893456000000,
			},
			attrs: txtypes.L2TxAttributes{txtypes.AttributeTypeSkipTxNonce: 1},
		},
	}

	for i, ov := range orderVariants {
		o := ov.order
		tx := &txtypes.L2CreateOrderTxInfo{
			AccountIndex:   1,
			ApiKeyIndex:    0,
			OrderInfo:      &o,
			ExpiredAt:      1893456000000,
			Nonce:          int64(42 + i),
			L2TxAttributes: ov.attrs,
		}
		if err := tx.Validate(); err != nil {
			panic(fmt.Sprintf("%s: validate: %v", ov.name, err))
		}
		h, err := tx.Hash(oracleChainID)
		if err != nil {
			panic(err)
		}
		fields := map[string]string{
			"AccountIndex":     fmt.Sprintf("%d", tx.AccountIndex),
			"ApiKeyIndex":      fmt.Sprintf("%d", tx.ApiKeyIndex),
			"MarketIndex":      fmt.Sprintf("%d", o.MarketIndex),
			"ClientOrderIndex": fmt.Sprintf("%d", o.ClientOrderIndex),
			"BaseAmount":       fmt.Sprintf("%d", o.BaseAmount),
			"Price":            fmt.Sprintf("%d", o.Price),
			"IsAsk":            fmt.Sprintf("%d", o.IsAsk),
			"Type":             fmt.Sprintf("%d", o.Type),
			"TimeInForce":      fmt.Sprintf("%d", o.TimeInForce),
			"ReduceOnly":       fmt.Sprintf("%d", o.ReduceOnly),
			"TriggerPrice":     fmt.Sprintf("%d", o.TriggerPrice),
			"OrderExpiry":      fmt.Sprintf("%d", o.OrderExpiry),
			"ExpiredAt":        fmt.Sprintf("%d", tx.ExpiredAt),
			"Nonce":            fmt.Sprintf("%d", tx.Nonce),
		}
		emit(ov.name, txtypes.TxTypeL2CreateOrder, fields, ov.attrs, h)
	}

	// L2CancelOrder
	for i, idx := range []int64{1, txtypes.MaxClientOrderIndex, txtypes.MinOrderIndex} {
		tx := &txtypes.L2CancelOrderTxInfo{
			AccountIndex: 1,
			ApiKeyIndex:  0,
			MarketIndex:  int16(i),
			Index:        idx,
			ExpiredAt:    1893456000000,
			Nonce:        int64(7 + i),
		}
		if err := tx.Validate(); err != nil {
			panic(fmt.Sprintf("cancel_order[%d]: validate: %v", i, err))
		}
		h, err := tx.Hash(oracleChainID)
		if err != nil {
			panic(err)
		}
		emit(fmt.Sprintf("cancel_order/%d", i), txtypes.TxTypeL2CancelOrder, map[string]string{
			"AccountIndex": "1",
			"ApiKeyIndex":  "0",
			"MarketIndex":  fmt.Sprintf("%d", i),
			"Index":        fmt.Sprintf("%d", idx),
			"ExpiredAt":    "1893456000000",
			"Nonce":        fmt.Sprintf("%d", 7+i),
		}, txtypes.L2TxAttributes{}, h)
	}

	// -------------------------------------------------------------------------
	// Every remaining L2 transaction type the SDK can construct.
	//
	// Each entry supplies a struct that satisfies Validate() and a field map for
	// the TypeScript side to rebuild the same input. Values are chosen to
	// exercise the awkward edges: amounts wider than 32 bits (which the protocol
	// splits into lo/hi field elements), signed negatives, sentinel/nil values,
	// and boundary indices.
	// -------------------------------------------------------------------------

	const exp = int64(1893456000000)
	f := func(v any) string { return fmt.Sprintf("%v", v) }

	type txCase struct {
		name   string
		txType uint8
		tx     interface {
			Validate() error
			Hash(uint32) ([]byte, error)
		}
		fields map[string]string
		attrs  txtypes.L2TxAttributes
	}

	pubKey := schnorr.SchnorrPkFromSk(sk).ToLittleEndianBytes()

	// Amounts deliberately above 2^32 so the lo/hi split is exercised.
	const bigAmount = int64(0x1_2345_6789) // > 2^32
	const bigFee = int64(0xABCD_EF01)      // just under 2^32
	const hugeAmount = uint64(0x7F_FFFF_FFFF)

	// Public pools are addressed in the sub-account index range (>= 1<<47).
	const poolIndex = txtypes.MinSubAccountIndex + 100

	// Staking pools are likewise addressed in the sub-account index range.
	const stakingPoolIndex = txtypes.MinSubAccountIndex + 7

	cases := []txCase{
		{
			name: "cancel_all_orders/immediate", txType: txtypes.TxTypeL2CancelAllOrders,
			tx: &txtypes.L2CancelAllOrdersTxInfo{
				AccountIndex: 1, ApiKeyIndex: 0,
				TimeInForce: txtypes.ImmediateCancelAll, Time: 0,
				ExpiredAt: exp, Nonce: 11,
			},
			fields: map[string]string{"AccountIndex": "1", "ApiKeyIndex": "0", "TimeInForce": f(txtypes.ImmediateCancelAll), "Time": "0", "ExpiredAt": f(exp), "Nonce": "11"},
		},
		{
			// Per-market cancel-all is only legal with ImmediateCancelAll; the
			// scheduled variant rejects the market-index attribute.
			name: "cancel_all_orders/immediate_single_market", txType: txtypes.TxTypeL2CancelAllOrders,
			tx: &txtypes.L2CancelAllOrdersTxInfo{
				AccountIndex: 1, ApiKeyIndex: 0,
				TimeInForce: txtypes.ImmediateCancelAll, Time: 0,
				ExpiredAt: exp, Nonce: 12,
				L2TxAttributes: txtypes.L2TxAttributes{txtypes.AttributeTypeCancelAllMarketIndex: 3},
			},
			fields: map[string]string{"AccountIndex": "1", "ApiKeyIndex": "0", "TimeInForce": f(txtypes.ImmediateCancelAll), "Time": "0", "ExpiredAt": f(exp), "Nonce": "12"},
			attrs:  txtypes.L2TxAttributes{txtypes.AttributeTypeCancelAllMarketIndex: 3},
		},
		{
			name: "cancel_all_orders/scheduled", txType: txtypes.TxTypeL2CancelAllOrders,
			tx: &txtypes.L2CancelAllOrdersTxInfo{
				AccountIndex: 1, ApiKeyIndex: 0,
				TimeInForce: txtypes.ScheduledCancelAll, Time: exp,
				ExpiredAt: exp, Nonce: 31,
			},
			fields: map[string]string{"AccountIndex": "1", "ApiKeyIndex": "0", "TimeInForce": f(txtypes.ScheduledCancelAll), "Time": f(exp), "ExpiredAt": f(exp), "Nonce": "31"},
		},
		{
			// AccountIndex = MinAccountIndex = -1 is legal. A negative protocol
			// integer sign-extends to 64 bits and is then reduced mod p, so -1
			// becomes 2^32 - 2 = 4294967294, NOT p - 1. Getting this wrong
			// produces a hash that looks fine and verifies against nothing.
			name: "cancel_all_orders/negative_account_index", txType: txtypes.TxTypeL2CancelAllOrders,
			tx: &txtypes.L2CancelAllOrdersTxInfo{
				AccountIndex: txtypes.MinAccountIndex, ApiKeyIndex: 0,
				TimeInForce: txtypes.ImmediateCancelAll, Time: 0,
				ExpiredAt: exp, Nonce: 34,
			},
			fields: map[string]string{"AccountIndex": f(txtypes.MinAccountIndex), "ApiKeyIndex": "0", "TimeInForce": f(txtypes.ImmediateCancelAll), "Time": "0", "ExpiredAt": f(exp), "Nonce": "34"},
		},
		{
			// ApiKeyIndex at its maximum (254) plus a boundary account index.
			name: "cancel_all_orders/max_indices", txType: txtypes.TxTypeL2CancelAllOrders,
			tx: &txtypes.L2CancelAllOrdersTxInfo{
				AccountIndex: txtypes.MaxAccountIndex, ApiKeyIndex: txtypes.MaxApiKeyIndex,
				TimeInForce: txtypes.ImmediateCancelAll, Time: 0,
				ExpiredAt: exp, Nonce: 35,
			},
			fields: map[string]string{"AccountIndex": f(txtypes.MaxAccountIndex), "ApiKeyIndex": f(txtypes.MaxApiKeyIndex), "TimeInForce": f(txtypes.ImmediateCancelAll), "Time": "0", "ExpiredAt": f(exp), "Nonce": "35"},
		},
		{
			name: "modify_order/basic", txType: txtypes.TxTypeL2ModifyOrder,
			tx: &txtypes.L2ModifyOrderTxInfo{
				AccountIndex: 1, ApiKeyIndex: 0, MarketIndex: 1, Index: 12345,
				BaseAmount: 5000, Price: 777777, TriggerPrice: txtypes.NilOrderTriggerPrice,
				ExpiredAt: exp, Nonce: 13,
			},
			fields: map[string]string{"AccountIndex": "1", "ApiKeyIndex": "0", "MarketIndex": "1", "Index": "12345", "BaseAmount": "5000", "Price": "777777", "TriggerPrice": f(txtypes.NilOrderTriggerPrice), "ExpiredAt": f(exp), "Nonce": "13"},
		},
		{
			name: "transfer/large_amount_lo_hi_split", txType: txtypes.TxTypeL2Transfer,
			tx: &txtypes.L2TransferTxInfo{
				FromAccountIndex: 1, ApiKeyIndex: 0, ToAccountIndex: 2,
				AssetIndex:    int16(txtypes.USDCAssetIndex),
				FromRouteType: txtypes.AssetRouteType_Perps, ToRouteType: txtypes.AssetRouteType_Spot,
				Amount: bigAmount, USDCFee: bigFee,
				ExpiredAt: exp, Nonce: 14,
			},
			fields: map[string]string{"FromAccountIndex": "1", "ApiKeyIndex": "0", "ToAccountIndex": "2", "AssetIndex": f(txtypes.USDCAssetIndex), "FromRouteType": f(txtypes.AssetRouteType_Perps), "ToRouteType": f(txtypes.AssetRouteType_Spot), "Amount": f(bigAmount), "USDCFee": f(bigFee), "ExpiredAt": f(exp), "Nonce": "14"},
		},
		{
			name: "transfer/small_amount", txType: txtypes.TxTypeL2Transfer,
			tx: &txtypes.L2TransferTxInfo{
				FromAccountIndex: 1, ApiKeyIndex: 0, ToAccountIndex: 3,
				AssetIndex:    int16(txtypes.NativeAssetIndex),
				FromRouteType: txtypes.AssetRouteType_Spot, ToRouteType: txtypes.AssetRouteType_Spot,
				Amount: 1, USDCFee: 0,
				ExpiredAt: exp, Nonce: 15,
			},
			fields: map[string]string{"FromAccountIndex": "1", "ApiKeyIndex": "0", "ToAccountIndex": "3", "AssetIndex": f(txtypes.NativeAssetIndex), "FromRouteType": f(txtypes.AssetRouteType_Spot), "ToRouteType": f(txtypes.AssetRouteType_Spot), "Amount": "1", "USDCFee": "0", "ExpiredAt": f(exp), "Nonce": "15"},
		},
		{
			name: "withdraw/large_amount_lo_hi_split", txType: txtypes.TxTypeL2Withdraw,
			tx: &txtypes.L2WithdrawTxInfo{
				FromAccountIndex: 1, ApiKeyIndex: 0,
				AssetIndex: int16(txtypes.USDCAssetIndex), RouteType: txtypes.AssetRouteType_Perps,
				Amount: hugeAmount, ExpiredAt: exp, Nonce: 16,
			},
			fields: map[string]string{"FromAccountIndex": "1", "ApiKeyIndex": "0", "AssetIndex": f(txtypes.USDCAssetIndex), "RouteType": f(txtypes.AssetRouteType_Perps), "Amount": f(hugeAmount), "ExpiredAt": f(exp), "Nonce": "16"},
		},
		{
			name: "update_leverage/cross", txType: txtypes.TxTypeL2UpdateLeverage,
			tx: &txtypes.L2UpdateLeverageTxInfo{
				AccountIndex: 1, ApiKeyIndex: 0, MarketIndex: 1,
				InitialMarginFraction: 500, MarginMode: txtypes.CrossMargin,
				ExpiredAt: exp, Nonce: 17,
			},
			fields: map[string]string{"AccountIndex": "1", "ApiKeyIndex": "0", "MarketIndex": "1", "InitialMarginFraction": "500", "MarginMode": f(txtypes.CrossMargin), "ExpiredAt": f(exp), "Nonce": "17"},
		},
		{
			name: "update_leverage/isolated", txType: txtypes.TxTypeL2UpdateLeverage,
			tx: &txtypes.L2UpdateLeverageTxInfo{
				AccountIndex: 1, ApiKeyIndex: 0, MarketIndex: 2,
				InitialMarginFraction: 200, MarginMode: txtypes.IsolatedMargin,
				ExpiredAt: exp, Nonce: 18,
			},
			fields: map[string]string{"AccountIndex": "1", "ApiKeyIndex": "0", "MarketIndex": "2", "InitialMarginFraction": "200", "MarginMode": f(txtypes.IsolatedMargin), "ExpiredAt": f(exp), "Nonce": "18"},
		},
		{
			name: "update_margin/add", txType: txtypes.TxTypeL2UpdateMargin,
			tx: &txtypes.L2UpdateMarginTxInfo{
				AccountIndex: 1, ApiKeyIndex: 0, MarketIndex: 1,
				USDCAmount: bigAmount, Direction: txtypes.AddToIsolatedMargin,
				ExpiredAt: exp, Nonce: 19,
			},
			fields: map[string]string{"AccountIndex": "1", "ApiKeyIndex": "0", "MarketIndex": "1", "USDCAmount": f(bigAmount), "Direction": f(txtypes.AddToIsolatedMargin), "ExpiredAt": f(exp), "Nonce": "19"},
		},
		{
			name: "change_pub_key", txType: txtypes.TxTypeL2ChangePubKey,
			tx: &txtypes.L2ChangePubKeyTxInfo{
				AccountIndex: 1, ApiKeyIndex: 0, PubKey: pubKey,
				ExpiredAt: exp, Nonce: 20,
			},
			fields: map[string]string{"AccountIndex": "1", "ApiKeyIndex": "0", "PubKeyLeHex": hex.EncodeToString(pubKey), "ExpiredAt": f(exp), "Nonce": "20"},
		},
		{
			name: "create_sub_account", txType: txtypes.TxTypeL2CreateSubAccount,
			tx: &txtypes.L2CreateSubAccountTxInfo{
				AccountIndex: 1, ApiKeyIndex: 0, ExpiredAt: exp, Nonce: 21,
			},
			fields: map[string]string{"AccountIndex": "1", "ApiKeyIndex": "0", "ExpiredAt": f(exp), "Nonce": "21"},
		},
		{
			name: "mint_shares", txType: txtypes.TxTypeL2MintShares,
			tx: &txtypes.L2MintSharesTxInfo{
				AccountIndex: 1, ApiKeyIndex: 0, PublicPoolIndex: poolIndex, ShareAmount: 5000,
				ExpiredAt: exp, Nonce: 22,
			},
			fields: map[string]string{"AccountIndex": "1", "ApiKeyIndex": "0", "PublicPoolIndex": f(poolIndex), "ShareAmount": "5000", "ExpiredAt": f(exp), "Nonce": "22"},
		},
		{
			name: "burn_shares", txType: txtypes.TxTypeL2BurnShares,
			tx: &txtypes.L2BurnSharesTxInfo{
				AccountIndex: 1, ApiKeyIndex: 0, PublicPoolIndex: poolIndex, ShareAmount: 2500,
				ExpiredAt: exp, Nonce: 23,
			},
			fields: map[string]string{"AccountIndex": "1", "ApiKeyIndex": "0", "PublicPoolIndex": f(poolIndex), "ShareAmount": "2500", "ExpiredAt": f(exp), "Nonce": "23"},
		},
		{
			name: "stake_assets", txType: txtypes.TxTypeL2StakeAssets,
			tx: &txtypes.L2StakeAssetsTxInfo{
				AccountIndex: 1, ApiKeyIndex: 0, StakingPoolIndex: stakingPoolIndex, ShareAmount: 1_000_000,
				ExpiredAt: exp, Nonce: 24,
			},
			fields: map[string]string{"AccountIndex": "1", "ApiKeyIndex": "0", "StakingPoolIndex": f(stakingPoolIndex), "ShareAmount": "1000000", "ExpiredAt": f(exp), "Nonce": "24"},
		},
		{
			name: "unstake_assets", txType: txtypes.TxTypeL2UnstakeAssets,
			tx: &txtypes.L2UnstakeAssetsTxInfo{
				AccountIndex: 1, ApiKeyIndex: 0, StakingPoolIndex: stakingPoolIndex, ShareAmount: 500_000,
				ExpiredAt: exp, Nonce: 25,
			},
			fields: map[string]string{"AccountIndex": "1", "ApiKeyIndex": "0", "StakingPoolIndex": f(stakingPoolIndex), "ShareAmount": "500000", "ExpiredAt": f(exp), "Nonce": "25"},
		},
		{
			name: "update_account_config", txType: txtypes.TxTypeL2UpdateAccountConfig,
			tx: &txtypes.L2UpdateAccountConfigTxInfo{
				AccountIndex: 1, ApiKeyIndex: 0, AccountTradingMode: 1,
				ExpiredAt: exp, Nonce: 26,
			},
			fields: map[string]string{"AccountIndex": "1", "ApiKeyIndex": "0", "AccountTradingMode": "1", "ExpiredAt": f(exp), "Nonce": "26"},
		},
		{
			name: "update_account_asset_config", txType: txtypes.TxTypeL2UpdateAccountAssetConfig,
			tx: &txtypes.L2UpdateAccountAssetConfigTxInfo{
				AccountIndex: 1, ApiKeyIndex: 0,
				AssetIndex: int16(txtypes.NativeAssetIndex), AssetMarginMode: txtypes.AccountAssetMarginMode_MarginEnabled,
				ExpiredAt: exp, Nonce: 27,
			},
			fields: map[string]string{"AccountIndex": "1", "ApiKeyIndex": "0", "AssetIndex": f(txtypes.NativeAssetIndex), "AssetMarginMode": f(txtypes.AccountAssetMarginMode_MarginEnabled), "ExpiredAt": f(exp), "Nonce": "27"},
		},
		{
			name: "approve_integrator", txType: txtypes.TxTypeL2ApproveIntegrator,
			tx: &txtypes.L2ApproveIntegratorTxInfo{
				AccountIndex: 1, ApiKeyIndex: 0, IntegratorAccountIndex: 4242,
				MaxPerpsTakerFee: 1000, MaxPerpsMakerFee: 500,
				MaxSpotTakerFee: 800, MaxSpotMakerFee: 400,
				ApprovalExpiry: exp, ExpiredAt: exp, Nonce: 28,
			},
			fields: map[string]string{"AccountIndex": "1", "ApiKeyIndex": "0", "IntegratorAccountIndex": "4242", "MaxPerpsTakerFee": "1000", "MaxPerpsMakerFee": "500", "MaxSpotTakerFee": "800", "MaxSpotMakerFee": "400", "ApprovalExpiry": f(exp), "ExpiredAt": f(exp), "Nonce": "28"},
		},
		{
			name: "create_public_pool", txType: txtypes.TxTypeL2CreatePublicPool,
			tx: &txtypes.L2CreatePublicPoolTxInfo{
				AccountIndex: 1, ApiKeyIndex: 0, OperatorFee: 100,
				InitialTotalShares: txtypes.MinInitialTotalShares, MinOperatorShareRate: 1000,
				ExpiredAt: exp, Nonce: 29,
			},
			fields: map[string]string{"AccountIndex": "1", "ApiKeyIndex": "0", "OperatorFee": "100", "InitialTotalShares": f(txtypes.MinInitialTotalShares), "MinOperatorShareRate": "1000", "ExpiredAt": f(exp), "Nonce": "29"},
		},
		{
			name: "update_public_pool", txType: txtypes.TxTypeL2UpdatePublicPool,
			tx: &txtypes.L2UpdatePublicPoolTxInfo{
				AccountIndex: 1, ApiKeyIndex: 0, PublicPoolIndex: poolIndex, Status: 1,
				OperatorFee: 200, MinOperatorShareRate: 2000,
				ExpiredAt: exp, Nonce: 30,
			},
			fields: map[string]string{"AccountIndex": "1", "ApiKeyIndex": "0", "PublicPoolIndex": f(poolIndex), "Status": "1", "OperatorFee": "200", "MinOperatorShareRate": "2000", "ExpiredAt": f(exp), "Nonce": "30"},
		},
	}

	// Grouped orders. Each grouping type has a distinct legal shape, and the
	// per-leg hashes are folded pairwise (the first leg is seeded, the rest are
	// combined two-at-a-time), so all three shapes need pinning.
	//
	//   OTO   exactly 2 legs: parent + one child, opposite sides, child size nil
	//   OCO   exactly 2 legs: one stop-loss + one take-profit, same side, both
	//         reduce-only, equal size, identical expiry
	//   OTOCO exactly 3 legs: parent + a stop-loss/take-profit pair
	groupCases := []struct {
		name         string
		groupingType uint8
		orders       []*txtypes.OrderInfo
		nonce        int64
	}{
		{
			name: "create_grouped_orders/oto", groupingType: txtypes.GroupingType_OneTriggersTheOther, nonce: 31,
			orders: []*txtypes.OrderInfo{
				{ // parent: resting limit buy
					MarketIndex: 1, ClientOrderIndex: 2001, BaseAmount: 1000, Price: 5000,
					IsAsk: 0, Type: txtypes.LimitOrder, TimeInForce: txtypes.GoodTillTime,
					ReduceOnly: 0, TriggerPrice: txtypes.NilOrderTriggerPrice, OrderExpiry: exp,
				},
				{ // child: stop-loss on the opposite side, size inherited from parent
					MarketIndex: 1, ClientOrderIndex: 2002, BaseAmount: txtypes.NilOrderBaseAmount, Price: 4000,
					IsAsk: 1, Type: txtypes.StopLossOrder, TimeInForce: txtypes.ImmediateOrCancel,
					ReduceOnly: 1, TriggerPrice: 4100, OrderExpiry: exp,
				},
			},
		},
		{
			name: "create_grouped_orders/oco", groupingType: txtypes.GroupingType_OneCancelsTheOther, nonce: 32,
			orders: []*txtypes.OrderInfo{
				{
					MarketIndex: 1, ClientOrderIndex: 2003, BaseAmount: txtypes.NilOrderBaseAmount, Price: 4000,
					IsAsk: 1, Type: txtypes.StopLossOrder, TimeInForce: txtypes.ImmediateOrCancel,
					ReduceOnly: 1, TriggerPrice: 4100, OrderExpiry: exp,
				},
				{
					MarketIndex: 1, ClientOrderIndex: 2004, BaseAmount: txtypes.NilOrderBaseAmount, Price: 6000,
					IsAsk: 1, Type: txtypes.TakeProfitOrder, TimeInForce: txtypes.ImmediateOrCancel,
					ReduceOnly: 1, TriggerPrice: 5900, OrderExpiry: exp,
				},
			},
		},
		{
			name: "create_grouped_orders/otoco", groupingType: txtypes.GroupingType_OneTriggersAOneCancelsTheOther, nonce: 33,
			orders: []*txtypes.OrderInfo{
				{ // parent
					MarketIndex: 1, ClientOrderIndex: 2005, BaseAmount: 2500, Price: 5000,
					IsAsk: 0, Type: txtypes.LimitOrder, TimeInForce: txtypes.GoodTillTime,
					ReduceOnly: 0, TriggerPrice: txtypes.NilOrderTriggerPrice, OrderExpiry: exp,
				},
				{ // stop-loss child
					MarketIndex: 1, ClientOrderIndex: 2006, BaseAmount: txtypes.NilOrderBaseAmount, Price: 4000,
					IsAsk: 1, Type: txtypes.StopLossOrder, TimeInForce: txtypes.ImmediateOrCancel,
					ReduceOnly: 1, TriggerPrice: 4100, OrderExpiry: exp,
				},
				{ // take-profit child
					MarketIndex: 1, ClientOrderIndex: 2007, BaseAmount: txtypes.NilOrderBaseAmount, Price: 6000,
					IsAsk: 1, Type: txtypes.TakeProfitOrder, TimeInForce: txtypes.ImmediateOrCancel,
					ReduceOnly: 1, TriggerPrice: 5900, OrderExpiry: exp,
				},
			},
		},
	}

	for _, gc := range groupCases {
		fields := map[string]string{
			"AccountIndex": "1", "ApiKeyIndex": "0",
			"GroupingType": f(gc.groupingType),
			"ExpiredAt":    f(exp), "Nonce": f(gc.nonce),
			"OrderCount": f(len(gc.orders)),
		}
		for i, o := range gc.orders {
			p := fmt.Sprintf("Order%d.", i)
			fields[p+"MarketIndex"] = f(o.MarketIndex)
			fields[p+"ClientOrderIndex"] = f(o.ClientOrderIndex)
			fields[p+"BaseAmount"] = f(o.BaseAmount)
			fields[p+"Price"] = f(o.Price)
			fields[p+"IsAsk"] = f(o.IsAsk)
			fields[p+"Type"] = f(o.Type)
			fields[p+"TimeInForce"] = f(o.TimeInForce)
			fields[p+"ReduceOnly"] = f(o.ReduceOnly)
			fields[p+"TriggerPrice"] = f(o.TriggerPrice)
			fields[p+"OrderExpiry"] = f(o.OrderExpiry)
		}
		cases = append(cases, txCase{
			name: gc.name, txType: txtypes.TxTypeL2CreateGroupedOrders,
			tx: &txtypes.L2CreateGroupedOrdersTxInfo{
				AccountIndex: 1, ApiKeyIndex: 0,
				GroupingType: gc.groupingType,
				Orders:       gc.orders, ExpiredAt: exp, Nonce: gc.nonce,
			},
			fields: fields,
		})
	}
	// -------------------------------------------------------------------------
	// L1 (EIP-191) signature bodies.
	//
	// Registering an API key, transferring, and approving an integrator each
	// require an Ethereum personal_sign over a formatted human-readable message.
	// The formatting rule is strict: every numeric argument becomes a 0x-prefixed,
	// 16-hex-digit zero-padded string. Pinning the exact bytes here means the
	// TypeScript implementation never has to guess the padding or field order.
	// -------------------------------------------------------------------------

	emitL1 := func(name string, fields map[string]string, body string) {
		v.L1Messages = append(v.L1Messages, l1MessageCase{
			Name:       name,
			Fields:     fields,
			Body:       body,
			BodyHex:    hex.EncodeToString([]byte(body)),
			EIP191Hash: hex.EncodeToString(accounts.TextHash([]byte(body))),
		})
	}

	cpk := &txtypes.L2ChangePubKeyTxInfo{
		AccountIndex: 1, ApiKeyIndex: 0, PubKey: pubKey, ExpiredAt: exp, Nonce: 20,
	}
	emitL1("change_pub_key", map[string]string{
		"AccountIndex": "1", "ApiKeyIndex": "0", "Nonce": "20",
		"PubKeyLeHex": hex.EncodeToString(pubKey),
	}, cpk.GetL1SignatureBody())

	// Two transfer bodies: one with an empty memo, one with a populated memo, so
	// the 32-byte memo hex encoding is pinned in both states.
	for _, memoCase := range []struct {
		label string
		memo  [32]byte
	}{
		{"empty_memo", [32]byte{}},
		{"populated_memo", func() (m [32]byte) { copy(m[:], "lighter-ts conformance vector"); return }()},
	} {
		tr := &txtypes.L2TransferTxInfo{
			FromAccountIndex: 1, ApiKeyIndex: 0, ToAccountIndex: 2,
			AssetIndex:    int16(txtypes.USDCAssetIndex),
			FromRouteType: txtypes.AssetRouteType_Perps, ToRouteType: txtypes.AssetRouteType_Spot,
			Amount: bigAmount, USDCFee: bigFee,
			Memo:      memoCase.memo,
			ExpiredAt: exp, Nonce: 14,
		}
		emitL1("transfer/"+memoCase.label, map[string]string{
			"FromAccountIndex": "1", "ApiKeyIndex": "0", "ToAccountIndex": "2",
			"AssetIndex":    f(txtypes.USDCAssetIndex),
			"FromRouteType": f(txtypes.AssetRouteType_Perps), "ToRouteType": f(txtypes.AssetRouteType_Spot),
			"Amount": f(bigAmount), "USDCFee": f(bigFee), "Nonce": "14",
			"ChainId": f(oracleChainID), "MemoHex": hex.EncodeToString(memoCase.memo[:]),
		}, tr.GetL1SignatureBody(oracleChainID))
	}

	ai := &txtypes.L2ApproveIntegratorTxInfo{
		AccountIndex: 1, ApiKeyIndex: 0, IntegratorAccountIndex: 4242,
		MaxPerpsTakerFee: 1000, MaxPerpsMakerFee: 500,
		MaxSpotTakerFee: 800, MaxSpotMakerFee: 400,
		ApprovalExpiry: exp, ExpiredAt: exp, Nonce: 28,
	}
	emitL1("approve_integrator", map[string]string{
		"AccountIndex": "1", "ApiKeyIndex": "0", "IntegratorAccountIndex": "4242",
		"MaxPerpsTakerFee": "1000", "MaxPerpsMakerFee": "500",
		"MaxSpotTakerFee": "800", "MaxSpotMakerFee": "400",
		"ApprovalExpiry": f(exp), "Nonce": "28", "ChainId": f(oracleChainID),
	}, ai.GetL1SignatureBody(oracleChainID))

	// The sub-account template takes only the master account index and has no
	// method on the tx type, so it is formatted directly from the template.
	for _, master := range []int64{1, txtypes.MaxMasterAccountIndex} {
		emitL1(fmt.Sprintf("create_sub_account/master_%d", master), map[string]string{
			"MasterAccountIndex": f(master),
		}, fmt.Sprintf(txtypes.TemplateSubAccount, l1Hex(uint64(master))))
	}

	// -------------------------------------------------------------------------
	// Read-only auth tokens.
	//
	// Authenticated REST reads carry a token built from the plain text
	// "<deadline>:<accountIndex>:<apiKeyIndex>", packed into Goldilocks field
	// elements 8 bytes at a time (little-endian, final chunk zero-padded),
	// hashed with Poseidon2, signed, and suffixed with the hex signature.
	//
	// Verified: the reference builds this through the *gnark* Poseidon2 variant
	// (types/tx_request.go imports hash/poseidon2_goldilocks) while transaction
	// hashing uses the *plonky2* variant (hash/poseidon2_goldilocks_plonky2).
	// The two produce byte-identical output — they differ only in internal field
	// representation — so lighter-ts implements one Poseidon2, not two.
	// -------------------------------------------------------------------------

	for _, at := range []struct {
		deadline     int64
		accountIndex int64
		apiKeyIndex  uint8
	}{
		{1750000000, 1, 0},
		{1893456000, 42, 3},
		{1750000000, txtypes.MaxMasterAccountIndex, txtypes.MaxApiKeyIndex},
	} {
		message := fmt.Sprintf("%v:%v:%v", at.deadline, at.accountIndex, at.apiKeyIndex)
		packed, err := g.ArrayFromCanonicalLittleEndianBytes([]byte(message))
		if err != nil {
			panic(fmt.Sprintf("auth token packing failed for %q: %v", message, err))
		}
		elems := make([]string, len(packed))
		plonky := make([]g.GoldilocksField, len(packed))
		for i, e := range packed {
			elems[i] = u64s(e.Uint64())
			plonky[i] = g.GoldilocksField(e.Uint64())
		}
		msgHash := p2.HashToQuinticExtension(plonky).ToLittleEndianBytes()

		e, err := gFp5.FromCanonicalLittleEndianBytes(msgHash)
		if err != nil {
			panic(err)
		}
		sigBytes := schnorr.SchnorrSignHashedMessage2(e, sk, nonceK).ToBytes()
		sigHex := hex.EncodeToString(sigBytes)

		v.AuthTokens = append(v.AuthTokens, authTokenCase{
			Deadline:     f(at.deadline),
			AccountIndex: f(at.accountIndex),
			ApiKeyIndex:  f(at.apiKeyIndex),
			Message:      message,
			MessageHex:   hex.EncodeToString([]byte(message)),
			PackedElems:  elems,
			MsgHashHex:   hex.EncodeToString(msgHash),
			NonceKLEHex:  scalarHex(nonceK),
			SigBytesHex:  sigHex,
			Token:        fmt.Sprintf("%v:%v", message, sigHex),
		})
	}

	for _, tc := range cases {
		if err := tc.tx.Validate(); err != nil {
			panic(fmt.Sprintf("%s: validate: %v", tc.name, err))
		}
		h, err := tc.tx.Hash(oracleChainID)
		if err != nil {
			panic(fmt.Sprintf("%s: hash: %v", tc.name, err))
		}
		attrs := tc.attrs
		if attrs == nil {
			attrs = txtypes.L2TxAttributes{}
		}
		emit(tc.name, tc.txType, tc.fields, attrs, h)
	}

	return v
}

// ---------------------------------------------------------------------------

func writeJSON(dir, name string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, b, 0o644); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "wrote %s (%d bytes)\n", path, len(b))
	return nil
}

func main() {
	out := flag.String("out", "../vectors", "directory to write vector JSON into")
	seed := flag.Uint64("seed", 0x1337_c0de_5eed_0001, "deterministic seed")
	flag.Parse()

	if err := os.MkdirAll(*out, 0o755); err != nil {
		panic(err)
	}

	groups := []struct {
		file string
		make func() any
	}{
		{"goldilocks.json", func() any { return buildGoldilocks(newRNG(*seed + 1)) }},
		{"gfp5.json", func() any { return buildFp5(newRNG(*seed + 2)) }},
		{"poseidon2.json", func() any { return buildPoseidon(newRNG(*seed + 3)) }},
		{"curve.json", func() any { return buildCurve(newRNG(*seed + 4)) }},
		{"schnorr.json", func() any { return buildSchnorr(newRNG(*seed + 5)) }},
		{"tx.json", func() any { return buildTx(newRNG(*seed + 6)) }},
	}

	for _, grp := range groups {
		if err := writeJSON(*out, grp.file, grp.make()); err != nil {
			panic(err)
		}
	}
}
