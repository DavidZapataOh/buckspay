// Package circuit holds the per-message validity circuit: one issue or spend of a note chain,
// proven with Groth16 over BN254 and verified on Solana.
package circuit

// NumPublic is the number of public inputs; gnark adds the BSB22 commitment on its own.
//
// Public input order:
//
//	0 e_hi  1 e_lo  2 ctrl  3 s_in  4 s_out  5 a_hi  6 a_lo  7 b_hi  8 b_lo  9 amt
//
// e_hi and e_lo are the message id bytes [0,16) and [16,32) as big-endian integers.
// ctrl is is_issue + 2*is_last + 4*next_bit.
// a is the issuer key (issue), or 0x00 followed by the payee account (last), or 0; a_hi is bytes
// [0,17) and a_lo bytes [17,33) of the 33 bytes.
// b is the mint (issue) split like e, or 0.
// amt is the last message amount * 2^32 + expiry, or the issued amount * 2^32 + lock_seq.
// s_in is 0 on the issue. Every s_* is a canonical field element.
const NumPublic = 10

const (
	CtrlIssue = 1
	CtrlLast  = 2
	CtrlNext1 = 4
)

const (
	// MaxBody is the longest message body, an issue.
	MaxBody = 163

	KindIssue  = 1
	KindSpend1 = 2
	KindSpend2 = 3

	IssueBodyLen  = 163
	Spend1BodyLen = 82
	Spend2BodyLen = 123

	// NoLock is the lock_seq of a spend that names no lock.
	NoLock = 0xFFFFFFFF
	// ExpiryStep is the least a payment to a device expires before the output it spends, in seconds.
	ExpiryStep = 3600
	// MaxHops is the deepest chain an issue may allow.
	MaxHops = 16
)
