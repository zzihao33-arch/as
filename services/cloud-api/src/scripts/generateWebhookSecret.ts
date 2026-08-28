import { randomBytes } from 'node:crypto';

console.log('Copy this signing secret into the upstream password manager now; it cannot be retrieved from CM-HUB:');
console.log(randomBytes(32).toString('base64url'));
