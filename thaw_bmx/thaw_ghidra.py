"""NOT ORIGINAL - read THAW's reference build in a private copy of its Ghidra project (the BMX work).

    GHIDRA_INSTALL_DIR=C:/ghidra uv run --no-project --python 3.13 --with pyghidra \\
        python -I tools/pipeline/thaw_bmx/thaw_ghidra.py [--project <folder>] [--program <exe name>] <command> <args...>

THAW's reference build is the THAW PC exe every THAW address in this project is named after (the decomp's local.json:
thawReferenceExe; its Ghidra project's folder thawGhidraProject, the program's name in it thawGhidraProgram - the
defaults of --project / --program). The project is made once with
`analyzeHeadless <project folder> <exe name without .exe> -import <the exe>`. Work in a copy (Copy-Item -Recurse
<project folder> <project folder>-<name>): functions Ghidra's auto-analysis missed (many - THAW's member functions are
only reached through tables a static initialiser fills) are created on first use. Addresses are hex without 0x.
Commands:

    funcs <address>...          size, callers, callees of the function at / containing each address
    disasm <address>...         its instructions
    decompile <address>...      Ghidra's C (a starting point only)
    survey <from> <to>          the functions Ghidra knows in a range, with sizes; their total
    operand <regex> <from> <to> the functions whose instructions match (e.g. "\\+ 0x524\\]" - the on-bike flag)
    scalars <address>...        the 32-bit constants each function uses (name them: THAW's dbg names, survey.ts)
"""
import os
import re
import sys

import pyghidra


def local_config():
    """The decomp's tools/ghidra/local_config.py (local.json's settings): the decomp checkout is THUG2_DECOMP or the
    nearest folder above this one with its CMakeLists.txt and src/game; None when this repository is on its own."""
    root = os.environ.get("THUG2_DECOMP")
    if not root:
        here = os.path.dirname(os.path.abspath(__file__))
        while os.path.dirname(here) != here:
            here = os.path.dirname(here)
            if os.path.isfile(os.path.join(here, "CMakeLists.txt")) and os.path.isdir(os.path.join(here, "src", "game")):
                root = here
                break
    if not root:
        return None
    sys.path.insert(0, os.path.join(root, "tools", "ghidra"))
    import local_config as config
    return config


def main():
    args = sys.argv[1:]
    config = local_config()
    project_dir = config.THAW_GHIDRA_PROJECT if config else ""
    exe = config.THAW_GHIDRA_PROGRAM if config else ""
    while args[:1] in (["--project"], ["--program"]):
        if args[0] == "--project":
            project_dir = args[1]
        else:
            exe = args[1]
        args = args[2:]
    if not project_dir or not exe:
        sys.exit("thaw_ghidra.py: THAW's reference build's Ghidra project: --project <folder> --program <exe name> "
                 "(or thawGhidraProject / thawGhidraProgram in the decomp's local.json)")
    pyghidra.start()
    # the project's name is the exe's without .exe (as analyzeHeadless made it)
    project_name = exe.rsplit(".", 1)[0]
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
                by = sorted(callers(f))
                print(label(f), "size", size(f), "callers", len(by), "(%s)" % " ".join("%08X" % c for c in by),
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
        else:
            sys.exit("unknown command " + cmd)


main()
