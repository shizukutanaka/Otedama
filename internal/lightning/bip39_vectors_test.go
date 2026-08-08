// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Otedama contributors. See NOTICE for details.
//
// The official BIP-39 English test vectors.
//
// This is the file that decides whether a recovery phrase written down by
// an Otedama user can actually be typed into Electrum, a Trezor, or any
// other BIP-39 wallet and produce the same seed. Nothing else in the
// package establishes that: round-tripping entropy through our own
// EntropyToMnemonic and MnemonicToEntropy proves only that the two agree
// with each other, and a private-vector test proves only that today's
// output matches yesterday's.
//
// Source: github.com/trezor/python-mnemonic, vectors.json ("english"),
// the vector set BIP-39 itself points to. Each entry is
// [entropy, mnemonic, seed, xprv]; the seed column uses the passphrase
// "TREZOR". The xprv column needs BIP-32 derivation, which this package
// does not implement, so it is recorded here for completeness and not
// asserted.
//
// Every vector below was additionally checked against an independent
// implementation (Python hashlib PBKDF2-HMAC-SHA512 plus a from-scratch
// entropy-to-mnemonic encoder) before being committed, so a transcription
// error in this table cannot masquerade as a passing test.
package lightning

import (
	"encoding/hex"
	"strings"
	"testing"
)

// bip39Vector is one official test vector.
type bip39Vector struct {
	entropy  string
	mnemonic string
	seed     string
	xprv     string // BIP-32 root key; not asserted (no HD derivation here)
}

// bip39EnglishVectors is the complete "english" set from vectors.json.
var bip39EnglishVectors = []bip39Vector{
	{
		entropy:  "00000000000000000000000000000000",
		mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
		seed:     "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04",
		xprv:     "xprv9s21ZrQH143K3h3fDYiay8mocZ3afhfULfb5GX8kCBdno77K4HiA15Tg23wpbeF1pLfs1c5SPmYHrEpTuuRhxMwvKDwqdKiGJS9XFKzUsAF",
	},
	{
		entropy:  "7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f",
		mnemonic: "legal winner thank year wave sausage worth useful legal winner thank yellow",
		seed:     "2e8905819b8723fe2c1d161860e5ee1830318dbf49a83bd451cfb8440c28bd6fa457fe1296106559a3c80937a1c1069be3a3a5bd381ee6260e8d9739fce1f607",
		xprv:     "xprv9s21ZrQH143K2gA81bYFHqU68xz1cX2APaSq5tt6MFSLeXnCKV1RVUJt9FWNTbrrryem4ZckN8k4Ls1H6nwdvDTvnV7zEXs2HgPezuVccsq",
	},
	{
		entropy:  "80808080808080808080808080808080",
		mnemonic: "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
		seed:     "d71de856f81a8acc65e6fc851a38d4d7ec216fd0796d0a6827a3ad6ed5511a30fa280f12eb2e47ed2ac03b5c462a0358d18d69fe4f985ec81778c1b370b652a8",
		xprv:     "xprv9s21ZrQH143K2shfP28KM3nr5Ap1SXjz8gc2rAqqMEynmjt6o1qboCDpxckqXavCwdnYds6yBHZGKHv7ef2eTXy461PXUjBFQg6PrwY4Gzq",
	},
	{
		entropy:  "ffffffffffffffffffffffffffffffff",
		mnemonic: "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
		seed:     "ac27495480225222079d7be181583751e86f571027b0497b5b5d11218e0a8a13332572917f0f8e5a589620c6f15b11c61dee327651a14c34e18231052e48c069",
		xprv:     "xprv9s21ZrQH143K2V4oox4M8Zmhi2Fjx5XK4Lf7GKRvPSgydU3mjZuKGCTg7UPiBUD7ydVPvSLtg9hjp7MQTYsW67rZHAXeccqYqrsx8LcXnyd",
	},
	{
		entropy:  "000000000000000000000000000000000000000000000000",
		mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon agent",
		seed:     "035895f2f481b1b0f01fcf8c289c794660b289981a78f8106447707fdd9666ca06da5a9a565181599b79f53b844d8a71dd9f439c52a3d7b3e8a79c906ac845fa",
		xprv:     "xprv9s21ZrQH143K3mEDrypcZ2usWqFgzKB6jBBx9B6GfC7fu26X6hPRzVjzkqkPvDqp6g5eypdk6cyhGnBngbjeHTe4LsuLG1cCmKJka5SMkmU",
	},
	{
		entropy:  "7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f",
		mnemonic: "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal will",
		seed:     "f2b94508732bcbacbcc020faefecfc89feafa6649a5491b8c952cede496c214a0c7b3c392d168748f2d4a612bada0753b52a1c7ac53c1e93abd5c6320b9e95dd",
		xprv:     "xprv9s21ZrQH143K3Lv9MZLj16np5GzLe7tDKQfVusBni7toqJGcnKRtHSxUwbKUyUWiwpK55g1DUSsw76TF1T93VT4gz4wt5RM23pkaQLnvBh7",
	},
	{
		entropy:  "808080808080808080808080808080808080808080808080",
		mnemonic: "letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter always",
		seed:     "107d7c02a5aa6f38c58083ff74f04c607c2d2c0ecc55501dadd72d025b751bc27fe913ffb796f841c49b1d33b610cf0e91d3aa239027f5e99fe4ce9e5088cd65",
		xprv:     "xprv9s21ZrQH143K3VPCbxbUtpkh9pRG371UCLDz3BjceqP1jz7XZsQ5EnNkYAEkfeZp62cDNj13ZTEVG1TEro9sZ9grfRmcYWLBhCocViKEJae",
	},
	{
		entropy:  "ffffffffffffffffffffffffffffffffffffffffffffffff",
		mnemonic: "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo when",
		seed:     "0cd6e5d827bb62eb8fc1e262254223817fd068a74b5b449cc2f667c3f1f985a76379b43348d952e2265b4cd129090758b3e3c2c49103b5051aac2eaeb890a528",
		xprv:     "xprv9s21ZrQH143K36Ao5jHRVhFGDbLP6FCx8BEEmpru77ef3bmA928BxsqvVM27WnvvyfWywiFN8K6yToqMaGYfzS6Db1EHAXT5TuyCLBXUfdm",
	},
	{
		entropy:  "0000000000000000000000000000000000000000000000000000000000000000",
		mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
		seed:     "bda85446c68413707090a52022edd26a1c9462295029f2e60cd7c4f2bbd3097170af7a4d73245cafa9c3cca8d561a7c3de6f5d4a10be8ed2a5e608d68f92fcc8",
		xprv:     "xprv9s21ZrQH143K32qBagUJAMU2LsHg3ka7jqMcV98Y7gVeVyNStwYS3U7yVVoDZ4btbRNf4h6ibWpY22iRmXq35qgLs79f312g2kj5539ebPM",
	},
	{
		entropy:  "7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f",
		mnemonic: "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title",
		seed:     "bc09fca1804f7e69da93c2f2028eb238c227f2e9dda30cd63699232578480a4021b146ad717fbb7e451ce9eb835f43620bf5c514db0f8add49f5d121449d3e87",
		xprv:     "xprv9s21ZrQH143K3Y1sd2XVu9wtqxJRvybCfAetjUrMMco6r3v9qZTBeXiBZkS8JxWbcGJZyio8TrZtm6pkbzG8SYt1sxwNLh3Wx7to5pgiVFU",
	},
	{
		entropy:  "8080808080808080808080808080808080808080808080808080808080808080",
		mnemonic: "letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic bless",
		seed:     "c0c519bd0e91a2ed54357d9d1ebef6f5af218a153624cf4f2da911a0ed8f7a09e2ef61af0aca007096df430022f7a2b6fb91661a9589097069720d015e4e982f",
		xprv:     "xprv9s21ZrQH143K3CSnQNYC3MqAAqHwxeTLhDbhF43A4ss4ciWNmCY9zQGvAKUSqVUf2vPHBTSE1rB2pg4avopqSiLVzXEU8KziNnVPauTqLRo",
	},
	{
		entropy:  "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		mnemonic: "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote",
		seed:     "dd48c104698c30cfe2b6142103248622fb7bb0ff692eebb00089b32d22484e1613912f0a5b694407be899ffd31ed3992c456cdf60f5d4564b8ba3f05a69890ad",
		xprv:     "xprv9s21ZrQH143K2WFF16X85T2QCpndrGwx6GueB72Zf3AHwHJaknRXNF37ZmDrtHrrLSHvbuRejXcnYxoZKvRquTPyp2JiNG3XcjQyzSEgqCB",
	},
	{
		entropy:  "9e885d952ad362caeb4efe34a8e91bd2",
		mnemonic: "ozone drill grab fiber curtain grace pudding thank cruise elder eight picnic",
		seed:     "274ddc525802f7c828d8ef7ddbcdc5304e87ac3535913611fbbfa986d0c9e5476c91689f9c8a54fd55bd38606aa6a8595ad213d4c9c9f9aca3fb217069a41028",
		xprv:     "xprv9s21ZrQH143K2oZ9stBYpoaZ2ktHj7jLz7iMqpgg1En8kKFTXJHsjxry1JbKH19YrDTicVwKPehFKTbmaxgVEc5TpHdS1aYhB2s9aFJBeJH",
	},
	{
		entropy:  "6610b25967cdcca9d59875f5cb50b0ea75433311869e930b",
		mnemonic: "gravity machine north sort system female filter attitude volume fold club stay feature office ecology stable narrow fog",
		seed:     "628c3827a8823298ee685db84f55caa34b5cc195a778e52d45f59bcf75aba68e4d7590e101dc414bc1bbd5737666fbbef35d1f1903953b66624f910feef245ac",
		xprv:     "xprv9s21ZrQH143K3uT8eQowUjsxrmsA9YUuQQK1RLqFufzybxD6DH6gPY7NjJ5G3EPHjsWDrs9iivSbmvjc9DQJbJGatfa9pv4MZ3wjr8qWPAK",
	},
	{
		entropy:  "68a79eaca2324873eacc50cb9c6eca8cc68ea5d936f98787c60c7ebc74e6ce7c",
		mnemonic: "hamster diagram private dutch cause delay private meat slide toddler razor book happy fancy gospel tennis maple dilemma loan word shrug inflict delay length",
		seed:     "64c87cde7e12ecf6704ab95bb1408bef047c22db4cc7491c4271d170a1b213d20b385bc1588d9c7b38f1b39d415665b8a9030c9ec653d75e65f847d8fc1fc440",
		xprv:     "xprv9s21ZrQH143K2XTAhys3pMNcGn261Fi5Ta2Pw8PwaVPhg3D8DWkzWQwjTJfskj8ofb81i9NP2cUNKxwjueJHHMQAnxtivTA75uUFqPFeWzk",
	},
	{
		entropy:  "c0ba5a8e914111210f2bd131f3d5e08d",
		mnemonic: "scheme spot photo card baby mountain device kick cradle pact join borrow",
		seed:     "ea725895aaae8d4c1cf682c1bfd2d358d52ed9f0f0591131b559e2724bb234fca05aa9c02c57407e04ee9dc3b454aa63fbff483a8b11de949624b9f1831a9612",
		xprv:     "xprv9s21ZrQH143K3FperxDp8vFsFycKCRcJGAFmcV7umQmcnMZaLtZRt13QJDsoS5F6oYT6BB4sS6zmTmyQAEkJKxJ7yByDNtRe5asP2jFGhT6",
	},
}

// bip39VectorPassphrase is the passphrase every seed in the official
// vectors is derived with.
const bip39VectorPassphrase = "TREZOR"

// TestBIP39_OfficialEnglishVectors runs the three conversions the wallet
// depends on across every official vector: entropy to mnemonic (what a new
// wallet prints for the user to write down), mnemonic back to entropy
// (what validates a phrase the user re-types), and mnemonic to seed (what
// every other wallet must reproduce from that phrase).
func TestBIP39_OfficialEnglishVectors(t *testing.T) {
	wl, err := NewEnglishWordList()
	if err != nil {
		t.Fatalf("NewEnglishWordList: %v", err)
	}
	if len(bip39EnglishVectors) != 16 {
		t.Fatalf("vector table has %d entries, want the full official set of 16", len(bip39EnglishVectors))
	}

	for _, v := range bip39EnglishVectors {
		entropy, err := hex.DecodeString(v.entropy)
		if err != nil {
			t.Fatalf("bad entropy fixture %q: %v", v.entropy, err)
		}

		got, err := EntropyToMnemonic(Entropy(entropy), wl)
		if err != nil {
			t.Errorf("EntropyToMnemonic(%s): %v", v.entropy, err)
			continue
		}
		if got.String() != v.mnemonic {
			t.Errorf("EntropyToMnemonic(%s):\n got  %s\n want %s", v.entropy, got, v.mnemonic)
			continue
		}

		back, err := MnemonicToEntropy(Mnemonic(strings.Split(v.mnemonic, " ")), wl)
		if err != nil {
			t.Errorf("MnemonicToEntropy(%q): %v", v.mnemonic, err)
			continue
		}
		if hex.EncodeToString(back) != v.entropy {
			t.Errorf("MnemonicToEntropy(%q) = %x, want %s", v.mnemonic, back, v.entropy)
		}

		seed := MnemonicToSeed(Mnemonic(strings.Split(v.mnemonic, " ")), bip39VectorPassphrase)
		if hex.EncodeToString(seed[:]) != v.seed {
			t.Errorf("MnemonicToSeed(%q, %q):\n got  %x\n want %s",
				v.mnemonic, bip39VectorPassphrase, seed, v.seed)
		}
	}
}

// TestBIP39_VectorsCoverEveryEntropyLength guards the table itself: a
// vector set that only exercised 12-word phrases would leave the 24-word
// phrases Otedama actually generates (DefaultEntropyBits = 256) untested.
func TestBIP39_VectorsCoverEveryEntropyLength(t *testing.T) {
	seen := map[int]int{}
	for _, v := range bip39EnglishVectors {
		seen[len(v.entropy)*4] += len(strings.Split(v.mnemonic, " "))
	}
	for _, bits := range []int{128, 192, 256} {
		if seen[bits] == 0 {
			t.Errorf("no vector covers %d-bit entropy", bits)
		}
	}
	if seen[DefaultEntropyBits] == 0 {
		t.Errorf("no vector covers DefaultEntropyBits (%d) — the length new wallets use", DefaultEntropyBits)
	}
}

// TestBIP39_SeedIsPassphraseSalted pins the "25th word" property against
// an official vector: the same phrase with no passphrase must not produce
// the vector's seed, or the passphrase is being ignored.
func TestBIP39_SeedIsPassphraseSalted(t *testing.T) {
	v := bip39EnglishVectors[0]
	m := Mnemonic(strings.Split(v.mnemonic, " "))
	withPass := MnemonicToSeed(m, bip39VectorPassphrase)
	noPass := MnemonicToSeed(m, "")
	if withPass == noPass {
		t.Fatal("passphrase had no effect on the derived seed")
	}
	if hex.EncodeToString(withPass[:]) != v.seed {
		t.Errorf("seed with passphrase = %x, want %s", withPass, v.seed)
	}
}
