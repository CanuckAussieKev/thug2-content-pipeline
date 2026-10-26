"""NOT ORIGINAL - read THAW.exe in a private copy of the THAW Ghidra project (the BMX survey).

    GHIDRA_INSTALL_DIR=C:/ghidra uv run --no-project --python 3.13 --with pyghidra \
        python -I tools/pipeline/thaw_bmx/thaw_ghidra.py [--project C:/Games/THAW-ghidra-bmx] [--program <exe name>] <command> <args...>

Work in a copy (Copy-Item -Recurse C:/Games/THAW-ghidra C:/Games/THAW-ghidra-<name>): functions Ghidra's auto-analysis
missed (many - THAW's member functions are only reached through tables a static initialiser fills) are created on
first use. Addresses are hex without 0x. Commands:

    funcs <address>...          size, callers, callees of the function at / containing each address
    disasm <address>...         its instructions
    decompile <address>...      Ghidra's C (a starting point only)
    survey <from> <to>          the functions Ghidra knows in a range, with sizes; their total
    operand <regex> <from> <to> the functions whose instructions match (e.g. "\\+ 0x524\\]" - the on-bike flag)
    scalars <address>...        the 32-bit constants each function uses (name them: THAW's dbg names, survey.ts)
    obfuscated [<from> <to>]     calls / jumps from THAW's own code (the first .text) into the obfuscated sections
                                (>= 0x857000): its virtual machine entries, one per stolen instruction or call
"""
import re
import sys

import pyghidra

pyghidra.start()

OBFUSCATED_SECTIONS = 0x857000  # the second .text, .init, .data...: the obfuscated ones


def main():
    args = sys.argv[1:]
    project_dir, project_name, exe = None, "THAW", "THAW.exe"
    while args[:1] in (["--project"], ["--program"]):
        if args[0] == "--project":
            project_dir = args[1]
        else:
            # --program <exe name>: another program, in the --project named with it - the second THAW PC build
            #, in a project made once by
            # analyzeHeadless <project folder> <exe name without .exe> -import <its exe>
            exe = args[1]
            project_name = exe.rsplit(".", 1)[0]
        args = args[2:]
    if project_dir is None:
        if project_name != "THAW":
            sys.exit("thaw_ghidra.py: --program needs --project <its Ghidra project folder>")
        project_dir = "C:/Games/THAW-ghidra-bmx"
    cmd, args = args[0], args[1:]
    with pyghidra.open_project(project_dir, project_name) as project, \
            pyghidra.program_context(project, "/" + exe) as program:
        fm = program.getFunctionManager()
        listing = program.getListing()
        refs = program.getReferenceManager()
        space = program.getAddressFactory().getDefaultAddressSpace()
        at = lambda v: space.getAddress(v)

        def ensure(v):
            f = fm.getFunctionAt(at(v)) or fm.getFunctionContaining(at(v))
            if f:
                return f
            from ghidra.app.cmd.disassemble import DisassembleCommand
            from ghidra.app.cmd.function import CreateFunctionCmd
            tx = program.startTransaction("create")
            try:
                DisassembleCommand(at(v), None, True).applyTo(program)
                CreateFunctionCmd(at(v)).applyTo(program)
            finally:
                program.endTransaction(tx, True)
            return fm.getFunctionAt(at(v))

        def size(f):
            return f.getBody().getNumAddresses()

        def label(f):
            return "%08X %s" % (f.getEntryPoint().getOffset(), f.getName())

        def callers(f):
            out = set()
            for r in refs.getReferencesTo(f.getEntryPoint()):
                g = fm.getFunctionContaining(r.getFromAddress())
                if g:
                    out.add(g.getEntryPoint().getOffset())
            return out

        def functions(lo, hi):
            for f in fm.getFunctions(at(lo), True):
                if f.getEntryPoint().getOffset() >= hi:
                    break
                yield f

        if cmd == "funcs":
            for a in args:
                f = ensure(int(a, 16))
                if not f:
                    print(a, "no function")
                    continue
                callees = sorted(g.getEntryPoint().getOffset() for g in f.getCalledFunctions(None))
                print(label(f), "size", size(f), "callers", len(callers(f)),
                      "callees", " ".join("%08X" % c for c in callees))
        elif cmd == "disasm":
            for a in args:
                f = ensure(int(a, 16))
                print("// ===", label(f), size(f))
                for ins in listing.getInstructions(f.getBody(), True):
                    print("%08X  %s" % (ins.getAddress().getOffset(), ins))
        elif cmd == "decompile":
            from ghidra.app.decompiler import DecompInterface
            decompiler = DecompInterface()
            decompiler.openProgram(program)
            for a in args:
                f = ensure(int(a, 16))
                result = decompiler.decompileFunction(f, 120, None)
                print("// ===", label(f), size(f))
                print(result.getDecompiledFunction().getC() if result.decompileCompleted() else result.getErrorMessage())
        elif cmd == "survey":
            total = count = 0
            for f in functions(int(args[0], 16), int(args[1], 16)):
                total += size(f)
                count += 1
                print("%s size %d callers %d" % (label(f), size(f), len(callers(f))))
            print("total", count, total)
        elif cmd == "operand":
            rx = re.compile(args[0], re.I)
            for f in functions(int(args[1], 16), int(args[2], 16)):
                hits = [str(i) for i in listing.getInstructions(f.getBody(), True) if rx.search(str(i))]
                if hits:
                    print("%s size %d hits %d  %s" % (label(f), size(f), len(hits), " | ".join(sorted(set(hits))[:4])))
        elif cmd == "scalars":
            for a in args:
                f = ensure(int(a, 16))
                values = []
                for ins in listing.getInstructions(f.getBody(), True):
                    for k in range(ins.getNumOperands()):
                        for o in ins.getOpObjects(k):
                            if hasattr(o, "getUnsignedValue"):
                                v = o.getUnsignedValue() & 0xFFFFFFFF
                                if v > 0x10000 and not (0x400000 <= v < 0x1900000):
                                    values.append("%08x" % v)
                print("%s size %d : %s" % (label(f), size(f), " ".join(dict.fromkeys(values))))
        elif cmd == "obfuscated":
            lo, hi = (int(args[0], 16), int(args[1], 16)) if args else (0x401000, 0x68E000)
            for f in functions(lo, hi):
                for ins in listing.getInstructions(f.getBody(), True):
                    flow = ins.getFlowType()
                    if not flow.isCall() and not flow.isJump():
                        continue
                    for target in ins.getFlows():
                        if target.getOffset() >= OBFUSCATED_SECTIONS:
                            print("%08X in %s -> %08X" % (ins.getAddress().getOffset(), label(f), target.getOffset()))
        else:
            sys.exit("unknown command " + cmd)


main()
