// page.ts — the review page's bundle: the kit's shell around the editor. Apart
// from entry.ts because probe.mjs imports entry.ts in node, where /_kit/kit.js
// is not there to load. A module runs once the markup is parsed and before the
// load event, so the shell stands before the editor's init looks for its parts.
import './entry.ts';
import { mountShell } from './shell.ts';

mountShell(() => window.galleyEdit.app?.askRevise());
