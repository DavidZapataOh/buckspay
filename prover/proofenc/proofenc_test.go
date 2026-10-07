package proofenc

import "testing"

func TestFlagRewritesAreInverse(t *testing.T) {
	for _, top := range []byte{0x40, 0x80, 0xC0} {
		in := []byte{top | 0x15, 0xAA}
		ark := ArkFlags(append([]byte(nil), in...))
		back := GnarkFlags(append([]byte(nil), ark...))
		if string(back) != string(in) {
			t.Fatalf("flags %#x: %x became %x", top, in, back)
		}
	}
}

func TestArkFlagsFollowTheSyscallLayout(t *testing.T) {
	cases := map[byte]byte{0x80: 0x00, 0xC0: 0x80, 0x40: 0x40}
	for gnark, ark := range cases {
		if got := ArkFlags([]byte{gnark | 0x01})[0]; got != ark|0x01 {
			t.Fatalf("gnark %#x: got %#x, want %#x", gnark, got, ark|0x01)
		}
	}
}
