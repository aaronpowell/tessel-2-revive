/*
 * musl-stdio-fixup.h — force-included (gcc -include) ahead of soc/*.c.
 *
 * t2-firmware/soc/usbexecd.c names struct members and function parameters
 * `stdin`, `stdout`, and `stderr`. In musl's <stdio.h> those are object-like
 * macros (`#define stdin (stdin)` etc.), so `p->stdin` preprocesses to
 * `p->(stdin)` — "expected identifier before '(' token". This first pulls in
 * <stdio.h> (setting its include guard) and then undefs the three macros, so
 * the members/params parse as plain identifiers. The underlying
 * `extern FILE *const stdin/stdout/stderr;` declarations remain, so any real
 * use of the standard streams still resolves correctly.
 */
#include <stdio.h>
#undef stdin
#undef stdout
#undef stderr
