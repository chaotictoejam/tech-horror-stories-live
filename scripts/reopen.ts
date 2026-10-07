// Reopens submissions after npm run kill.
import { setSubmissions } from './kill-switch.js';

await setSubmissions(true);
