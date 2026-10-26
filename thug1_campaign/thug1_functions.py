"""NOT ORIGINAL - sizing aid for the THUG1 campaign survey: imports THUG1's
THUG.exe (not wrapped by an encrypting loader: plain .text / .rdata / .data sections) into a Ghidra project of its own,
analyses it once, and dumps every function's entry, size and callees as JSON - enough to measure how much code sits
under a CFunction or member function (the transitive callees not shared with the rest of the engine). Nothing is
decompiled. The exe is only read.

    GHIDRA_INSTALL_DIR=C:/ghidra uv run --no-project --python 3.13 --with pyghidra \
        python -I tools/pipeline/thug1_campaign/thug1_functions.py [C:/Games/THUG1/Game/THUG.exe] [C:/Games/THUG1-ghidra] [out.json]

The project (C:/Games/THUG1-ghidra/THUG1) is created on the first run (analysis: several minutes) and reused after.
"""
import json
import pathlib
import sys

import pyghidra

pyghidra.start()

# THUG.exe's CFunction table (tools/pipeline/thug1_campaign/script_gap.ts finds it by a scan: 0x00686AC0, 1144 entries).
CFUNC_TABLE = 0x00686AC0
CFUNC_COUNT = 1144


def main():
    exe = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "C:/Games/THUG1/Game/THUG.exe")
    project = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "C:/Games/THUG1-ghidra")
    out = pathlib.Path(sys.argv[3] if len(sys.argv) > 3 else "data/derived/thug1_functions.json")
    project.mkdir(parents=True, exist_ok=True)
    with pyghidra.open_program(str(exe), project_location=str(project), project_name="THUG1", analyze=True) as api:
        program = api.getCurrentProgram()
        fm = program.getFunctionManager()
        monitor = api.getMonitor()
        # The CFunctions are reached only through their table ({char* name, function} pairs at CFUNC_TABLE): Ghidra's
        # analysis leaves many of them without a function. Make one at each, then let the analysis follow them.
        space = program.getAddressFactory().getDefaultAddressSpace()
        mem = program.getMemory()
        made = 0
        for i in range(CFUNC_COUNT):
            target = mem.getInt(space.getAddress(CFUNC_TABLE + i * 8 + 4)) & 0xFFFFFFFF
            addr = space.getAddress(target)
            if fm.getFunctionAt(addr) is None:
                if fm.getFunctionContaining(addr) is None:
                    api.disassemble(addr)
                if api.createFunction(addr, None) is not None:
                    made += 1
        if made:
            api.analyzeChanges(program)
        print(f"{made} CFunctions made into functions")
        rows = []
        for f in fm.getFunctions(True):
            callees = sorted(c.getEntryPoint().getOffset() for c in f.getCalledFunctions(monitor))
            rows.append({
                "entry": f.getEntryPoint().getOffset(),
                "size": f.getBody().getNumAddresses(),
                "callees": callees,
            })
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rows), encoding="utf-8")
    print(f"{len(rows)} functions -> {out}")


if __name__ == "__main__":
    main()
