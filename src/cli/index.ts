import { run } from "./program.js";

process.exitCode = await run(process.argv);
