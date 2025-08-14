// Otedama ZKP Client-Side Logic (Schnorr Protocol)

// --- Core ZKP Parameters (must match server-side config) ---
// A large prime number (p)
const p = BigInt('23992346986434786549598124020385574583538633535221234567890123456789012345678901234567890123456789');
// A generator (g) of the multiplicative group of integers modulo p
const g = BigInt('5');

// --- Helper Functions ---

/**
 * Generates a random BigInt number between 1 and n-1.
 * @param {BigInt} n - The upper bound (exclusive).
 * @returns {BigInt} A random BigInt.
 */
function getRandomBigInt(n) {
    const byteLength = (n.toString(16).length + 1) >> 1;
    let randomBytes = new Uint8Array(byteLength);
    let randomBigInt;

    do {
        window.crypto.getRandomValues(randomBytes);
        let hex = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');
        randomBigInt = BigInt('0x' + hex);
    } while (randomBigInt >= n || randomBigInt === 0n); // Ensure the number is within the valid range (1 to n-1)

    return randomBigInt;
}

/**
 * Hashes a message using SHA-256.
 * @param {string} message - The message to hash.
 * @returns {Promise<BigInt>} A promise that resolves to the hash as a BigInt.
 */
async function sha256(message) {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return BigInt('0x' + hashHex);
}

// --- ZKP Implementation ---

/**
 * Generates a ZKP key pair (private and public keys).
 * @returns {{privateKey: BigInt, publicKey: BigInt}} The generated key pair.
 */
function generateKeys() {
    const privateKey = getRandomBigInt(p - 1n); // v (secret)
    const publicKey = g ** privateKey % p;      // y = g^v mod p
    return { privateKey, publicKey };
}

/**
 * Generates a ZKP proof for a given message and private key.
 * @param {string} message - The message to prove knowledge of (e.g., username or session ID).
 * @param {BigInt} privateKey - The user's private key (v).
 * @returns {Promise<{commitment: BigInt, proof: BigInt}>} A promise that resolves to the commitment and proof.
 */
async function generateProof(message, privateKey) {
    // 1. Commitment
    const r = getRandomBigInt(p - 1n); // Ephemeral secret
    const t = g ** r % p;              // Commitment: t = g^r mod p

    // 2. Challenge
    const c = await sha256(t.toString() + message); // Challenge: c = H(t, M)

    // 3. Response
    // s = r + c*v mod (p-1)
    const s = (r + c * privateKey) % (p - 1n);

    return { commitment: t, proof: s };
}

// --- Example Usage (for testing in browser console) ---
/*
async function runZkpExample() {
    console.log("Running ZKP Example...");

    // 1. User generates keys (private key is kept secret)
    const { privateKey, publicKey } = generateKeys();
    console.log("Private Key (v):", privateKey.toString());
    console.log("Public Key (y):", publicKey.toString());

    // This public key would be registered with the server beforehand.

    // 2. User wants to log in. The server will ask for a proof for a specific message.
    const messageToProve = "user-login-attempt-12345";
    console.log("Message to prove:", messageToProve);

    // 3. Client generates the proof
    const { commitment, proof } = await generateProof(messageToProve, privateKey);
    console.log("Commitment (t):", commitment.toString());
    console.log("Proof (s):", proof.toString());

    // 4. Client sends (publicKey, commitment, proof) to the server for verification.
    console.log("--- Data to send to server ---");
    console.log(JSON.stringify({ 
        publicKey: publicKey.toString(), 
        commitment: commitment.toString(), 
        proof: proof.toString(),
        message: messageToProve
    }, null, 2));

    console.log("ZKP Example Finished.");
}

// To run: runZkpExample();
*/
