#!/usr/bin/env python3
"""Exact-arithmetic model of what a claim burns, against the mechanisms that pay claimants out of a
bond, under every strategy of every party that can touch a lock.

Run: python3 econ.py            (prints the comparison tables)
     python3 econ.py --check    (asserts the properties the program relies on; exits non-zero on failure)

Parties. The wallet W owns the bond B. The device key K signs the lock's messages: K is W's own key
(the owner is the culprit) or somebody else's (a rooted phone, a stolen key, a delegate or an
authority-only holder). Real victims lost goods to a double spend. The key holder can file claims
of accounts it controls ("sybils") and, because issues and spends cost nothing to sign, can make
outputs up: a claim of a made-up output is indistinguishable on chain from a real victim's.

A mechanism decides, from the free bond and the claims filed, what burns and what is paid, and to
whom. Amounts are in units of B = 100; a payment limit L = 25 (bond / (GAMMA * SLOTS)).

  pooled   commit = min(free, GAMMA * claims), 75% burns, 25% is paid to the claims pro rata; claims
           against one consumed output are capped at SLOTS * amount
  veto     pooled, and the wallet may send the restitution back to the free bond within the window
  evidence pooled, and a claim needs a spend of the backing that was really paid (not just a record)
  burn     what the program does: each claim burns min(free, 2 * its loss) and nothing is paid to
           anyone
"""
import random
import sys
from fractions import Fraction as F

B = F(100)
GAMMA = F(2)
SLOTS = 2
L = B / (GAMMA * SLOTS)          # 25
E = B / GAMMA                    # 50, what a bond backs in all


class Claim:
    """One counted claim: `amount` lost in an `output` of `size`; `real` if a third party lost it."""

    def __init__(self, amount, output, size, real):
        self.amount, self.output, self.size, self.real = F(amount), output, F(size), real


def counted(claims, capped):
    """The pooled mechanisms' cap: claims on one output add up to SLOTS * size, first come, a claim
    that does not fit counts for what is left."""
    if not capped:
        return list(claims)
    used, out = {}, []
    for c in claims:
        room = SLOTS * c.size - used.get(c.output, F(0))
        take = min(c.amount, room)
        if take > 0:
            used[c.output] = used.get(c.output, F(0)) + take
            out.append(Claim(take, c.output, c.size, c.real))
    return out


def run(mech, free, claims, w_vetoes=True, w_attentive=True):
    """(burn, paid per claim, returned to the free bond) for `claims` in the order filed."""
    if mech == "burn":
        burn, paid = F(0), [F(0)] * len(claims)
        for c in claims:
            b = min(free - burn, 2 * c.amount)
            burn += b
        return burn, paid, F(0)
    cs = counted(claims, True)
    total = sum(c.amount for c in cs)
    commit = min(free, GAMMA * total)
    burn = F(3, 4) * commit
    rest = commit - burn
    paid = [c.amount if total <= rest else rest * c.amount / total for c in cs]
    if mech == "veto" and w_attentive and w_vetoes:
        return burn, [F(0)] * len(cs), rest
    return burn, paid, rest - sum(paid)


def counted_claims(mech, claims):
    return counted(claims, mech != "burn")


# --- strategies -------------------------------------------------------------------------------

def strategy(rng, party):
    """A random strategy of `party`: 'owner' (K is W's key) or 'thief' (K belongs to somebody else).
    Real victims lose payments of the note they were paid with; the key holder adds claims of its
    own on the same output (sybils) and, for outputs it makes up, claims on fresh ones."""
    claims = []
    out = 0
    for _ in range(rng.randint(0, 3)):                       # real victims of one note
        size = rng.choice([L, L, L / 2, F(1)])
        for _ in range(rng.randint(1, 2)):
            claims.append(Claim(rng.choice([size, size / 2]), out, size, True))
        out += 1
    for _ in range(rng.randint(0, 6)):                       # claims of accounts it controls
        size = rng.choice([L, L / 2, F(1)])
        on = rng.choice([None] + list(range(out))) if out else None
        if on is None:
            on, out = out, out + 1                           # a made-up output: free
            sz = size
        else:
            sz = next(c.size for c in claims if c.output == on)
        claims.append(Claim(min(sz, rng.choice([sz, sz / 2, F(1)])), on, sz, False))
    rng.shuffle(claims)
    return claims


def payoffs(mech, party, claims, w_vetoes=True, w_attentive=True, free=B):
    """What each party gets, for one strategy, in one mechanism."""
    cs = counted_claims(mech, claims)
    burn, paid, returned = run(mech, free, cs, w_vetoes, w_attentive)
    real_paid = sum(p for c, p in zip(cs, paid) if c.real)
    sybil_paid = sum(p for c, p in zip(cs, paid) if not c.real)
    stolen = sum(c.amount for c in claims if c.real)          # what the culprit took from victims
    # the key holder's profit out of the bond: what its own claimants are paid
    extracted = sybil_paid
    owner_net = stolen - burn - real_paid                     # its own claimants' payouts come back
    w_loss = burn + real_paid + sybil_paid
    recovery = real_paid / sum(c.amount for c in claims if c.real) if stolen else None
    return dict(burn=burn, extracted=extracted, owner_net=owner_net, w_loss=w_loss,
                recovery=recovery, stolen=stolen, real_paid=real_paid)


def within_exposure(claims):
    real = [c for c in claims if c.real]
    return sum(c.amount for c in real) <= E and all(c.size <= L for c in claims)


def search(mech, party, n=60_000, seed=7, **kw):
    rng = random.Random(seed)
    best = dict(extracted=F(0), net_ratio=None, w_loss=F(0), recovery=F(1), worst=None)
    for _ in range(n):
        claims = strategy(rng, party)
        r = payoffs(mech, party, claims, **kw)
        best["extracted"] = max(best["extracted"], r["extracted"])
        best["w_loss"] = max(best["w_loss"], r["w_loss"])
        if r["stolen"] and within_exposure(claims):
            ratio = r["owner_net"] / r["stolen"]
            if best["net_ratio"] is None or ratio > best["net_ratio"]:
                best["net_ratio"], best["worst"] = ratio, claims
            if r["recovery"] is not None:
                best["recovery"] = min(best["recovery"], r["recovery"])
    return best


# --- named scenarios ------------------------------------------------------------------------------

def key_only_made_up(mech, w_attentive=True):
    """No note, no victim: two claims of 25 on a made-up output, filed by two accounts."""
    claims = [Claim(L, 0, L, False), Claim(L, 0, L, False)]
    return payoffs(mech, "thief", claims, w_attentive=w_attentive)


def key_only_five_made_up(mech):
    claims = [Claim(5, i, 5, False) for i in range(5) for _ in range(2)]
    return payoffs(mech, "thief", claims)


def three_locks(mech):
    """One note of 20, two victims on each of three locks. A cap shared between the locks is filled by
    the first lock's claims and every other lock's claims are refused. Returns the culprit's net."""
    a = F(20)
    stolen = 6 * a
    if mech == "burn":
        burned = 3 * min(B, 2 * 2 * a)
        return stolen - burned
    first = payoffs(mech, "owner", [Claim(a, 0, a, True), Claim(a, 0, a, True)])
    # the other four claims are refused: those locks keep their bonds
    return stolen - first["burn"] - first["real_paid"]


def n_notes(mech, n):
    """n notes of the maximum payment, one loser each, bond 100."""
    claims = [Claim(L, i, L, True) for i in range(n)]
    return payoffs(mech, "owner", claims)["owner_net"]


def apathy(mech, q):
    """The culprit steals the whole exposure; the victims file with probability q."""
    claims = [Claim(L, 0, L, True), Claim(L, 1, L, True)]
    r = payoffs(mech, "owner", claims)
    return r["stolen"] - q * (r["burn"] + r["real_paid"])


def fmt(x, nd=1):
    return "-" if x is None else f"{float(x):.{nd}f}"


MECHS = ["pooled", "veto", "evidence", "burn"]


def main():
    print("== 1. Every strategy of every party, four mechanisms (60,000 random strategies each, B = 100, L = 25)")
    print("   extracted = most a party that is not the owner is paid out of the bond; W loses = most the owner loses")
    print("   net/stolen = best the owner-culprit does inside the exposure (negative = it loses that fraction of what it stole)")
    print("mechanism | key-only holder extracts | owner-culprit net / stolen | real victims recover (worst) | wallet loses (worst)")
    for m in MECHS:
        thief = search(m, "thief")
        owner = search(m, "owner")
        print(f"{m:<9} | {fmt(thief['extracted']):>24} | {fmt(owner['net_ratio'], 2):>26} | "
              f"{fmt(owner['recovery'], 2):>29} | {fmt(max(thief['w_loss'], owner['w_loss'])):>20}")

    print("\n== 2. The named strategies, party by party (B = 100, L = 25)")
    print("   each cell: paid to a party that is not the owner / the owner's loss / the owner-culprit's net after paying real victims")
    cols = [("pooled", "pooled", True), ("veto, W awake", "veto", True), ("veto, W asleep", "veto", False), ("evidence", "evidence", True), ("burn", "burn", True)]
    scenarios = [
        ("key only, no note, 2 claims of 25 on a made-up output", "thief", [Claim(L, 0, L, False), Claim(L, 0, L, False)]),
        ("key only, 10 made-up claims of 5", "thief", [Claim(5, i, 5, False) for i in range(5) for _ in range(2)]),
        ("delegate / authority-only holder of a note of 25, files 2 claims of its own on it", "thief", [Claim(L, 0, L, False), Claim(L, 0, L, False)]),
        ("owner steals 25 from one victim, files 2 sybil claims of 25 on the output", "owner", [Claim(L, 0, L, True), Claim(L, 0, L, False), Claim(L, 0, L, False)]),
        ("owner steals 25, the victim rebates what it is paid", "owner", [Claim(L, 0, L, True)]),
        ("owner steals 25 from one victim, the victim files, nobody else", "owner", [Claim(L, 0, L, True)]),
        ("owner steals 50 from two victims, the victims file", "owner", [Claim(L, 0, L, True), Claim(L, 1, L, True)]),
        ("key thief double spends to 2 real victims of 25, files 2 claims of its own", "thief", [Claim(L, 0, L, True), Claim(L, 1, L, True), Claim(L, 2, L, False), Claim(L, 2, L, False)]),
    ]
    print("scenario | " + " | ".join(c[0] for c in cols))
    for name, party, claims in scenarios:
        cells = []
        for _, mech, awake in cols:
            r = payoffs(mech, party, claims, w_attentive=awake)
            extracted = r["extracted"]
            if name.startswith("owner steals 25, the victim rebates"):
                extracted = F(0)       # the rebate comes back to the owner: counted in its net
            cells.append(f"{fmt(extracted)} / {fmt(r['w_loss'])} / {fmt(r['owner_net']) if party == 'owner' else '-'}")
        print(f"{name} | " + " | ".join(cells))
    print("   evidence: the thief must also spend backing it can already take (25 per paid output); nothing is added to its cost")

    print("\n== 3. n notes of the maximum payment (25), one loser each, one lock of 100: owner-culprit net")
    print("n | stolen | pooled | burn | verdict (burn)")
    for n in range(1, 7):
        net = n_notes("burn", n)
        print(f"{n} | {fmt(n*L)} | {fmt(n_notes('pooled', n))} | {fmt(net)} | "
              f"{'loses' if net < 0 else ('break-even' if net == 0 else 'PROFITS')}")

    print("\n== 4. Apathy: the culprit steals the whole exposure (2 x 25), victims file with probability q")
    print("q | EV pooled (own claimants recycle) | EV burn")
    for q in (F(1), F(3, 4), F(2, 3), F(1, 2), F(1, 4)):
        recycle = payoffs("pooled", "owner", [Claim(L, 0, L, True), Claim(L, 1, L, True), Claim(F(10**6), 2, F(10**6), False)])
        ev2 = recycle["stolen"] - q * (recycle["burn"] + recycle["real_paid"])
        print(f"{fmt(q, 2)} | {fmt(ev2)} | {fmt(apathy('burn', q))}")
    print("threshold: burn pays off q > 1/2 (the multiple is 2); pooled needed q > 2/3 when its own claimants recycled")

    print("\n== 5. Parameter curve of the burn, bond 100 (burn multiple S, slots)")
    print("S | slots | exposure | payment limit | bond per payment | deterred while q > 1/S | owner loses on a theft of the exposure")
    for s, slots in [(F(3, 2), 2), (F(2), 1), (F(2), 2), (F(2), 3), (F(5, 2), 2), (F(3), 2)]:
        e = B / s
        print(f"{fmt(s, 2)} | {slots} | {fmt(e)} | {fmt(e/slots)} | x{fmt(s*slots)} | q > {fmt(1/s, 2)} | {fmt(s*e)} (the whole bond when S x E = B)")

    print("\n== 6. What the owner of a lock can lose when its key is taken (key holder files made-up claims)")
    print("pooled: the whole free bond is committed, 75 burned and 25 paid to the thief; burn: the free bond burns, the thief is paid nothing")
    print("so the loss is bounded by the bond in both, and only pooled pays the thief for it")


def check():
    # a pooled bond pays a key holder that makes claims up: 25 paid and 75 burned
    r = key_only_made_up("pooled")
    assert (r["extracted"], r["burn"]) == (25, 75)
    # every candidate that pays claimants pays a key holder who makes claims up, asleep or not:
    assert key_only_made_up("veto", w_attentive=False)["extracted"] == 25
    assert key_only_made_up("evidence")["extracted"] == 25
    # the veto stops it only while the wallet is awake, and then pays nobody, victims included
    assert key_only_made_up("veto")["extracted"] == 0
    # the burn pays nobody, whatever is filed, from 60,000 random strategies of each party
    for party in ("thief", "owner"):
        assert search("burn", party)["extracted"] == 0
    assert search("pooled", "thief")["extracted"] == 25
    assert search("veto", "thief", w_attentive=False)["extracted"] == 25
    assert search("veto", "thief")["extracted"] == 0
    # the owner-culprit loses at least what it stole (S = 2) inside the exposure, whatever it files
    best = search("burn", "owner")
    assert best["net_ratio"] <= -1, best["net_ratio"]
    # and with the pooled payout it only lost half of what it stole
    assert search("pooled", "owner")["net_ratio"] <= F(-1, 2)
    # real victims recover nothing from the burn and from the veto (the culprit vetoes), a quarter or
    # less from the pooled payout once somebody dilutes them
    assert search("burn", "owner")["recovery"] == 0
    # a key with three locks nets +40 under a shared cap and loses 120 under the burn
    assert three_locks("pooled") == 40 and three_locks("burn") == -120
    # the limit is exact: 25, 50, 75, 100, 125 stolen against a burn of 50, 100, 100, 100, 100
    nets = [n_notes("burn", n) for n in range(1, 7)]
    assert nets == [-25, -50, -25, 0, 25, 50], nets
    # apathy: break even at q = 1/2, loses above it
    assert apathy("burn", F(1, 2)) == 0 and apathy("burn", F(3, 5)) < 0 and apathy("burn", F(2, 5)) > 0
    # claims never lower the burn: adding any claims to any strategy never reduces it
    rng = random.Random(3)
    for _ in range(5000):
        claims = strategy(rng, "owner")
        more = claims + [Claim(F(rng.randint(1, 25)), 99, F(25), False)]
        assert payoffs("burn", "owner", more)["burn"] >= payoffs("burn", "owner", claims)["burn"]
        assert payoffs("burn", "owner", list(reversed(claims)))["burn"] == payoffs("burn", "owner", claims)["burn"]
    print("econ.py --check: ok")


if __name__ == "__main__":
    check() if "--check" in sys.argv else main()
