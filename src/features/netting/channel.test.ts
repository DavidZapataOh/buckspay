import { describe, expect, it } from 'vitest'
import { seeded } from '../../transport/testing/random'
import {
  ChannelError, decodeInvite, encodeInvite, HOST, INVITE_PREFIX, JOINING, newInvite, SessionChannel, sessionTag,
} from './channel'

const rng = (seed: number) => {
  const next = seeded(seed)
  return (n: number) => Uint8Array.from({ length: n }, () => Math.floor(next() * 256))
}
const invite = newInvite(rng(1))
const failure = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as ChannelError).code
const at = (ms: number) => () => ms
const flip = (frame: Uint8Array, i: number) => Uint8Array.from(frame, (b, j) => (j === i ? b ^ 1 : b))

describe('invite', () => {
  it('invite_round_trips_and_rejects_foreign_text', () => {
    const text = encodeInvite(invite)
    expect(text.startsWith(INVITE_PREFIX)).toBe(true)
    expect(decodeInvite(text)).toEqual(invite)
    for (const foreign of ['', 'hello', 'https://example.com/?i=AAAA', 'buckspay://pay?i=AAAA', INVITE_PREFIX]) {
      expect(() => decodeInvite(foreign)).toThrow(ChannelError)
    }
  })

  it('invite_rejects_wrong_length_and_bad_alphabet', () => {
    const text = encodeInvite(invite)
    expect(() => decodeInvite(text.slice(0, -4))).toThrow(ChannelError)
    expect(() => decodeInvite(`${text}AAAA`)).toThrow(ChannelError)
    expect(() => decodeInvite(`${text.slice(0, -1)}*`)).toThrow(ChannelError)
  })

  it('session_tag_is_eight_bytes_stable_and_depends_on_both_fields', () => {
    const tag = sessionTag(invite)
    expect(tag).toHaveLength(8)
    expect(sessionTag({ ...invite })).toEqual(tag)
    expect(sessionTag({ session: rng(2)(32), secret: invite.secret })).not.toEqual(tag)
    expect(sessionTag({ session: invite.session, secret: rng(3)(32) })).not.toEqual(tag)
  })
})

describe('frames', () => {
  const host = () => new SessionChannel(invite, HOST, at(1_000))
  const member = (i: number) => {
    const channel = new SessionChannel(invite, JOINING, at(1_000))
    channel.assign(i)
    return channel
  }

  it('seal_open_round_trip_per_sender', async () => {
    const [h, m3] = [host(), member(3)]
    const body = rng(4)(300)
    expect(await h.open(await m3.seal(0x12, body))).toEqual({ sender: 3, type: 0x12, body })
    expect(await m3.open(await h.seal(0x13, body))).toEqual({ sender: 0, type: 0x13, body })
    const empty = await h.open(await m3.seal(0x16, new Uint8Array(0)))
    expect(empty.body).toHaveLength(0)
  })

  it('replayed_counter_refused', async () => {
    const [h, m] = [host(), member(1)]
    const frame = await m.seal(0x14, rng(5)(64))
    await h.open(frame)
    expect(await failure(h.open(frame))).toBe('Replayed')
  })

  it('lower_counter_after_higher_refused', async () => {
    const [h, m] = [host(), member(2)]
    const first = await m.seal(0x14, rng(6)(64))
    const second = await m.seal(0x14, rng(7)(64))
    await h.open(second)
    expect(await failure(h.open(first))).toBe('Replayed')
  })

  it('frame_from_outside_key_refused', async () => {
    const outsider = new SessionChannel({ session: invite.session, secret: rng(8)(32) }, HOST, at(1_000))
    expect(await failure(host().open(await outsider.seal(0x11, rng(9)(40))))).toBe('Forged')
  })

  it('every_byte_of_a_frame_is_authenticated', async () => {
    const frame = await member(4).seal(0x12, rng(10)(48))
    for (let i = 0; i < frame.length; i++) {
      const outcome = await failure(host().open(flip(frame, i)))
      expect(['Forged', 'UnknownSender']).toContain(outcome)
    }
  })

  it('a_forged_frame_does_not_advance_the_counter', async () => {
    const [h, m] = [host(), member(1)]
    const frame = await m.seal(0x14, rng(11)(64))
    expect(await failure(h.open(flip(frame, frame.length - 1)))).toBe('Forged')
    expect((await h.open(frame)).type).toBe(0x14)
  })

  it('frame_for_other_session_refused', async () => {
    const other = new SessionChannel({ session: rng(12)(32), secret: invite.secret }, HOST, at(1_000))
    expect(await failure(member(1).open(await other.seal(0x11, rng(13)(10))))).toBe('Forged')
  })

  it('sender_field_rewritten_refused', async () => {
    const frame = await member(5).seal(0x14, rng(14)(64))
    for (const sender of [0, 1, 6, 7]) {
      const rewritten = Uint8Array.from(frame, (b, i) => (i === 0 ? sender : b))
      expect(await failure(host().open(rewritten))).toBe('Forged')
    }
    expect(await failure(host().open(Uint8Array.from(frame, (b, i) => (i === 0 ? 8 : b))))).toBe('UnknownSender')
  })

  it('joining_counters_are_tracked_per_link', async () => {
    const h = host()
    const a = new SessionChannel(invite, JOINING, at(1_000))
    const b = new SessionChannel(invite, JOINING, at(1_000))
    const fa = await a.seal(0x10, rng(15)(163))
    const fb = await b.seal(0x10, rng(16)(163))
    expect((await h.open(fa, 'endpoint-a')).sender).toBe(JOINING)
    expect((await h.open(fb, 'endpoint-b')).sender).toBe(JOINING)
    expect(await failure(h.open(fa, 'endpoint-a'))).toBe('Replayed')
  })

  it('counter_starts_above_previous_run_and_never_repeats_in_one_run', async () => {
    const first = new SessionChannel(invite, HOST, at(5_000))
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) seen.add(Buffer.from((await first.seal(0x16, Uint8Array.of(i))).slice(1, 9)).toString('hex'))
    expect(seen.size).toBe(50)
    const receiver = member(1)
    const last = await first.seal(0x16, Uint8Array.of(1))
    await receiver.open(last)
    const restarted = new SessionChannel(invite, HOST, at(5_001))
    expect((await receiver.open(await restarted.seal(0x16, Uint8Array.of(2)))).body).toEqual(Uint8Array.of(2))
  })

  it('truncated_and_oversized_frames_refused', async () => {
    const frame = await member(1).seal(0x14, rng(17)(64))
    for (const length of [0, 1, 9, 25]) expect(await failure(host().open(frame.slice(0, length)))).toBe('Malformed')
    expect(await failure(host().open(new Uint8Array(8192 + 27)))).toBe('Malformed')
  })

  it('assign_is_once_and_only_for_a_joining_channel', () => {
    const joining = new SessionChannel(invite, JOINING, at(1))
    joining.assign(2)
    expect(() => joining.assign(3)).toThrow(ChannelError)
    expect(() => new SessionChannel(invite, HOST, at(1)).assign(1)).toThrow(ChannelError)
    expect(() => new SessionChannel(invite, JOINING, at(1)).assign(0)).toThrow(ChannelError)
    expect(() => new SessionChannel(invite, JOINING, at(1)).assign(8)).toThrow(ChannelError)
  })

  it('a_joining_channel_cannot_seal_as_an_index_it_was_not_given', async () => {
    const joining = new SessionChannel(invite, JOINING, at(1_000))
    expect((await host().open(await joining.seal(0x10, rng(18)(163)), 'e')).sender).toBe(JOINING)
  })
})
