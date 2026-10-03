#!/usr/bin/env python3
"""Extract the SHA-256 fingerprint of the certificate embedded in an AAB/APK
signing block (APK Signature Scheme v2). Used to build the Android assetlinks.json
`sha256_cert_fingerprints` for App Links verification.

Usage: python3 scripts/extract-signing-cert.py /path/to/app.aab
"""
import hashlib
import struct
import sys


def find_signing_block(data: bytes):
    # APK Signing Block sits immediately before the End of Central Directory.
    eocd = data.rfind(b"PK\x05\x06")
    if eocd == -1:
        raise SystemExit("EOCD not found")
    # EOCD: signature(4) + disk numbers etc. Central directory offset at +16.
    cd_offset = struct.unpack_from("<I", data, eocd + 16)[0]
    block = data[cd_offset:eocd]
    # block: [size uint64][size bytes of pairs]
    size = struct.unpack_from("<Q", block, 0)[0]
    pairs = block[8 : 8 + size]
    pos = 0
    while pos + 8 <= len(pairs):
        length = struct.unpack_from("<Q", pairs, pos)[0]
        pos += 8
        if pos + length > len(pairs):
            break
        entry = pairs[pos : pos + length]
        pos += length
        entry_id = struct.unpack_from("<I", entry, 0)[0]
        value = entry[4:]
        yield entry_id, value


def parse_v2_scheme(block: bytes):
    # APK Signature Scheme v2 block:
    # sequence of length-prefixed signers; each signer: signed data, signatures,
    # public key; signed data: digests, certificates (length-prefixed X.509 DER).
    def take(data, offset, n):
        return data[offset : offset + n], offset + n

    pos = 0

    def read_u32():
        nonlocal pos
        v = struct.unpack_from("<I", block, pos)[0]
        pos += 4
        return v

    def read_len_prefixed():
        nonlocal pos
        n = read_u32()
        return take(block, pos, n)

    # signers count is a length-prefixed sequence
    _, pos = read_len_prefixed()
    certs_out = []
    # one signer
    _, pos = read_len_prefixed()  # signer
    signed_data, pos = read_len_prefixed()
    _, pos = read_len_prefixed()  # signatures
    _, pos = read_len_prefixed()  # public key

    sp = 0

    def s_read_u32():
        nonlocal sp
        v = struct.unpack_from("<I", signed_data, sp)[0]
        sp += 4
        return v

    def s_take(n):
        nonlocal sp
        v = signed_data[sp : sp + n]
        sp += n
        return v

    # signed data: digests (length-prefixed), certificates (length-prefixed)
    _, sp = s_take(s_read_u32())  # digests sequence
    _, sp = s_take(s_read_u32())  # certificates sequence
    _, sp = s_take(s_read_u32())  # first certificate (DER)
    return None


def main():
    path = sys.argv[1]
    data = open(path, "rb").read()
    for entry_id, value in find_signing_block(data):
        if entry_id == 0x7109871A:  # v2 signature scheme block
            # Parse v2 block to find the first certificate (X.509 DER).
            cert = parse_v2_cert(value)
            if cert:
                digest = hashlib.sha256(cert).hexdigest()
                print(digest)
                return
    print("NO_SIGNING_CERT_FOUND", file=sys.stderr)
    sys.exit(1)


def parse_v2_cert(block: bytes):
    pos = 0

    def read_u32():
        nonlocal pos
        v = struct.unpack_from("<I", block, pos)[0]
        pos += 4
        return v

    def read_len_prefixed():
        nonlocal pos
        n = read_u32()
        v = block[pos : pos + n]
        pos += n
        return v

    # signers (length-prefixed sequence of signers)
    read_len_prefixed()
    # one signer
    signer = read_len_prefixed()

    sp = 0

    def s_read_u32():
        nonlocal sp
        v = struct.unpack_from("<I", signer, sp)[0]
        sp += 4
        return v

    def s_read_len_prefixed():
        nonlocal sp
        n = s_read_u32()
        v = signer[sp : sp + n]
        sp += n
        return v

    signed_data = s_read_len_prefixed()
    s_read_len_prefixed()  # signatures
    s_read_len_prefixed()  # public key

    sd = 0

    def d_read_u32():
        nonlocal sd
        v = struct.unpack_from("<I", signed_data, sd)[0]
        sd += 4
        return v

    def d_read_len_prefixed():
        nonlocal sd
        n = d_read_u32()
        v = signed_data[sd : sd + n]
        sd += n
        return v

    d_read_len_prefixed()  # digests
    certs = d_read_len_prefixed()  # certificates (sequence of DER)
    c = 0
    n = struct.unpack_from("<I", certs, c)[0]
    c += 4
    return certs[c : c + n]


if __name__ == "__main__":
    main()
