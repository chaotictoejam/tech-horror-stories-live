// Closes submissions instantly. Undo with npm run reopen.
import { setSubmissions } from './kill-switch.js';

await setSubmissions(false);
