package netting

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"

	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
)

const (
	statementVersion = 1
	statementKind    = 0x32
	statementFixed   = 111
	sessionTag       = "BUCKSPAY:v1:netting-session"
)

// Statement is the body of a netting: what the participants sign and what the proof binds.
type Statement struct {
	Session, Mint [32]byte
	Participants  uint8
	Total         uint64
	Expires       uint32
	Root          [32]byte
	Ephemeral     [][32]byte
}

// DecodeStatement reads a statement body: exactly 111 + 32n bytes, version 1, kind 0x32, 2 ≤ n ≤ 8, distinct
// keys and a canonical root.
func DecodeStatement(b []byte) (Statement, error) {
	var s Statement
	if len(b) < statementFixed {
		return s, errors.New("statement too short")
	}
	n := int(b[66])
	if n < 2 || n > MaxParticipants {
		return s, fmt.Errorf("%d participants", n)
	}
	if len(b) != statementFixed+32*n {
		return s, fmt.Errorf("statement of %d bytes, want %d", len(b), statementFixed+32*n)
	}
	if b[0] != statementVersion || b[1] != statementKind {
		return s, errors.New("not a netting statement")
	}
	copy(s.Session[:], b[2:34])
	copy(s.Mint[:], b[34:66])
	s.Participants = uint8(n)
	s.Total = binary.LittleEndian.Uint64(b[67:75])
	s.Expires = binary.LittleEndian.Uint32(b[75:79])
	copy(s.Root[:], b[79:111])
	for i := 0; i < n; i++ {
		var k [32]byte
		copy(k[:], b[statementFixed+32*i:])
		s.Ephemeral = append(s.Ephemeral, k)
	}
	return s, s.check()
}

func (s Statement) check() error {
	n := int(s.Participants)
	if n < 2 || n > MaxParticipants || len(s.Ephemeral) != n {
		return errors.New("participants and keys disagree")
	}
	for i := range s.Ephemeral {
		for j := i + 1; j < n; j++ {
			if s.Ephemeral[i] == s.Ephemeral[j] {
				return errors.New("duplicate key")
			}
		}
	}
	var root fr.Element
	if err := root.SetBytesCanonical(s.Root[:]); err != nil {
		return errors.New("root is not a field element")
	}
	return nil
}

// Encode is the body DecodeStatement reads.
func (s Statement) Encode() []byte {
	b := make([]byte, 0, statementFixed+32*len(s.Ephemeral))
	b = append(b, statementVersion, statementKind)
	b = append(b, s.Session[:]...)
	b = append(b, s.Mint[:]...)
	b = append(b, s.Participants)
	b = binary.LittleEndian.AppendUint64(b, s.Total)
	b = binary.LittleEndian.AppendUint32(b, s.Expires)
	b = append(b, s.Root[:]...)
	for _, k := range s.Ephemeral {
		b = append(b, k[:]...)
	}
	return b
}

// Content is the SHA-256 of the body, the key of the on-chain record.
func (s Statement) Content() [32]byte { return sha256.Sum256(s.Encode()) }

// SessionField binds every byte of the body that the other public inputs do not: the session, the mint, the
// expiry and the key list. Its top three bits are cleared so that it is below the field modulus.
func SessionField(s Statement) [32]byte {
	h := sha256.New()
	h.Write([]byte(sessionTag))
	h.Write(s.Session[:])
	h.Write(s.Mint[:])
	h.Write(binary.LittleEndian.AppendUint32(nil, s.Expires))
	h.Write([]byte{s.Participants})
	for i := 0; i < int(s.Participants) && i < len(s.Ephemeral); i++ {
		h.Write(s.Ephemeral[i][:])
	}
	var out [32]byte
	h.Sum(out[:0])
	out[0] &= 0x1f
	return out
}

// Public lists the public inputs in verifier order, 32 big-endian bytes each.
func (s Statement) Public() [NumPublic][32]byte {
	var out [NumPublic][32]byte
	out[0] = SessionField(s)
	out[1][31] = s.Participants
	binary.BigEndian.PutUint64(out[2][24:], s.Total)
	out[3] = s.Root
	return out
}
