"""NOT ORIGINAL - map THAW.exe code addresses to a second THAW PC build's.

The second build (PE timestamp 2006-03-27) has THAW.exe 1.01's code at other addresses. This finds each THAW address's
place in it by instruction windows: both .text sections are disassembled linearly (capstone), each instruction
normalised (addresses and branch targets masked, struct offsets and small constants kept), and every window of WINDOW
instructions around a THAW address is looked up in the second build's; the commonest address difference among the hits
is the answer, with the share of windows that agreed (1.0: the code around it is the same).

    uv run --no-project --python 3.13 --with capstone python -I tools/pipeline/thaw_bmx/second_build_map.py \
        [--thaw <THAW.exe>] --second <its exe> [--json <out.json>] <address[=name]>... | --list <file>

Addresses are hex without 0x. --list reads one `address name...` per line (# comments). Reads the two exes only.
"""
import collections
import json
import re
import struct
import sys

import capstone

WINDOW = 6
REACH = 0x180  # bytes after the address whose windows vote (and 0x40 before it)


def sections(exe):
    pe = struct.unpack_from("<I", exe, 0x3C)[0]
    count = struct.unpack_from("<H", exe, pe + 6)[0]
    optional = struct.unpack_from("<H", exe, pe + 20)[0]
    base = struct.unpack_from("<I", exe, pe + 24 + 28)[0]
    out = []
    for i in range(count):
        h = pe + 24 + optional + 40 * i
        name = exe[h:h + 8].rstrip(b"\0").decode("latin-1")
        vsize, va, rsize, raw = struct.unpack_from("<IIII", exe, h + 8)
        out.append((name, base + va, vsize, raw, rsize))
    return out


HEX = re.compile(r"0x[0-9a-f]+")


def normalise(ins):
    m = ins.mnemonic
    if m == "call" or m.startswith("j") or m.startswith("loop"):
        return m + (" R" if ins.op_str.startswith("0x") else " " + HEX.sub(lambda h: "A" if int(h.group(0), 16) >= 0x400000 else h.group(0), ins.op_str))
    return m + " " + HEX.sub(lambda h: "A" if int(h.group(0), 16) >= 0x400000 else h.group(0), ins.op_str)


class Code:
    def __init__(self, path):
        exe = open(path, "rb").read()
        name, va, vsize, raw, rsize = sections(exe)[0]  # the first .text (THAW's own code in THAW.exe)
        self.lo, self.hi = va, va + min(vsize, rsize)
        md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
        md.skipdata = True
        self.addrs, self.norms, self.text = [], [], {}
        for ins in md.disasm(exe[raw:raw + min(vsize, rsize)], va):
            self.addrs.append(ins.address)
            self.norms.append(normalise(ins))
        self.index_of = {a: i for i, a in enumerate(self.addrs)}

    def window(self, i):
        return "|".join(self.norms[i:i + WINDOW])

    def at_or_after(self, address):
        import bisect
        return bisect.bisect_left(self.addrs, address)


def main():
    args = sys.argv[1:]
    thaw_path, second_path, json_path, targets = "C:/Games/THAW/Game/THAW.exe", None, None, []
    show, show_at, sites, diff = 0, {}, None, 0
    while args:
        a = args.pop(0)
        if a == "--thaw":
            thaw_path = args.pop(0)
        elif a == "--second":
            second_path = args.pop(0)
        elif a == "--json":
            json_path = args.pop(0)
        elif a == "--sites":
            # every site THAW.exe can't show (a call / jump into the sections >= 0x857000) in THAW's range lo-hi,
            # with the second build's instructions in its place
            sites = (int(args.pop(0), 16), int(args.pop(0), 16))
        elif a == "--diff":
            # with each mapped address: THAW's next N bytes (hex) against the second build's, differences listed
            diff = int(args.pop(0), 16)
        elif a == "--show":
            show = int(args.pop(0))
        elif a.startswith("--at="):
            # --at=<thaw>:<second> - with --show, the second build's place to list beside THAW's address
            t, r = a[5:].split(":")
            show_at[int(t, 16)] = int(r, 16)
        elif a == "--list":
            for line in open(args.pop(0), encoding="utf-8"):
                line = line.split("#")[0].strip()
                if line:
                    parts = line.split(None, 1)
                    targets.append((int(parts[0], 16), parts[1] if len(parts) > 1 else ""))
        else:
            address, _, name = a.partition("=")
            targets.append((int(address, 16), name))
    if second_path is None:
        sys.exit("second_build_map.py: --second <the second THAW build's exe> is needed")
    if show:
        # side by side: THAW's instructions from the address and the second build's from its mapped place (or a given one)
        md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
        for (address, name) in targets:
            for label, path, at in (("THAW", thaw_path, address), ("second", second_path, show_at.get(address))):
                if at is None:
                    continue
                exe = open(path, "rb").read()
                _, va, vsize, raw, rsize = sections(exe)[0]
                print("// %s %08X %s" % (label, at, name))
                for k, ins in enumerate(md.disasm(exe[raw + at - va:raw + at - va + show * 16], at)):
                    if k >= show:
                        break
                    print("%08X  %-24s %s %s" % (ins.address, ins.bytes.hex(), ins.mnemonic, ins.op_str))
        return
    thaw, second = Code(thaw_path), Code(second_path)
    table = collections.defaultdict(list)
    for i in range(len(second.norms) - WINDOW):
        table[second.window(i)].append(second.addrs[i])
    md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
    second_exe = open(second_path, "rb").read()
    _, second_va, _, second_raw, _ = sections(second_exe)[0]
    thaw_exe = open(thaw_path, "rb").read()
    _, th_va, _, th_raw, _ = sections(thaw_exe)[0]

    def listing(exe, va, raw, at, count):
        out = []
        for k, ins in enumerate(md.disasm(exe[raw + at - va:raw + at - va + count * 16], at)):
            if k >= count:
                break
            out.append(ins)
        return out

    if sites:
        for i, a in enumerate(thaw.addrs):
            if not sites[0] <= a < sites[1]:
                continue
            n = thaw.norms[i]
            (ins,) = listing(thaw_exe, th_va, th_raw, a, 1)
            target = None
            if ins.mnemonic in ("call", "jmp") or ins.mnemonic.startswith("j"):
                m = re.match(r"^(?:dword ptr \[)?(0x[0-9a-f]+)\]?$", ins.op_str)
                if m:
                    target = int(m.group(1), 16)
            if target is None or target < 0x857000:
                continue
            targets.append((a, "site %s %s" % (ins.mnemonic, ins.op_str)))
    results = []
    for address, name in targets:
        start = thaw.at_or_after(address - 0x40)
        votes = collections.Counter()
        windows = 0
        i = start
        while i < len(thaw.addrs) - WINDOW and thaw.addrs[i] < address + REACH:
            windows += 1
            hits = table.get(thaw.window(i), ())
            if 0 < len(hits) <= 8:
                for h in hits:
                    votes[h - thaw.addrs[i]] += 1.0 / len(hits)
            i += 1
        if votes:
            delta, score = votes.most_common(1)[0]
            mapped, share = address + delta, score / max(windows, 1)
        else:
            mapped, share, delta = None, 0.0, None
        results.append({"thaw": "%08X" % address, "name": name, "second": None if mapped is None else "%08X" % mapped,
                        "delta": delta, "share": round(share, 3)})
        print("%08X -> %s  share %.2f  %s" % (address, "--------" if mapped is None else "%08X" % mapped, share, name))
        if diff and mapped is not None:
            # THAW's next `diff` bytes against the second build's from the mapped place: the differing instructions, apart
            # from THAW's jumps / calls into the sections >= 0x857000 - any other difference would show here
            import difflib
            i0, j0 = thaw.at_or_after(address), second.at_or_after(mapped)
            i1, j1 = thaw.at_or_after(address + diff), second.at_or_after(mapped + diff)
            a, b = thaw.norms[i0:i1], second.norms[j0:j1]
            changes = []
            for tag, x0, x1, y0, y1 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
                if tag == "equal":
                    continue
                theirs = [n for n in a[x0:x1] if not n.startswith(("jmp dword ptr [A]", "call R", "push "))]
                if not theirs and all(n.startswith(("mov", "lea", "test", "cmp", "push", "fld", "movss")) for n in b[y0:y1]) \
                        and y1 - y0 <= 3:
                    continue  # (THAW's jump there, the second build's instruction in its place)
                changes.append("%08X: %s  =>  %08X: %s" % (thaw.addrs[i0 + x0], " ; ".join(a[x0:x1]) or "-",
                                                          second.addrs[j0 + y0], " ; ".join(b[y0:y1]) or "-"))
            results[-1]["differences"] = len(changes)
            print("        %d differences%s" % (len(changes), "".join("\n          " + c for c in changes[:8])))
        if sites and mapped is not None:
            # the second build's instructions where THAW's site is, up to where THAW's next instruction lands
            (site,) = listing(thaw_exe, th_va, th_raw, address, 1)
            end = address + site.size + delta
            for ins in listing(second_exe, second_va, second_raw, mapped, 6):
                if ins.address >= end and ins.address > mapped:
                    break
                print("        %08X  %s %s" % (ins.address, ins.mnemonic, ins.op_str))
                results[-1].setdefault("instructions", []).append("%s %s" % (ins.mnemonic, ins.op_str))
    if json_path:
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(results, f, indent=1)
            f.write("\n")


main()
