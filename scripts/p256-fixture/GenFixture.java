import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Predicate;

/**
 * Prints P-256 signatures in the format Android Keystore returns (X.509 public key, DER
 * {@code SHA256withECDSA} signature) over random {@code note} envelopes, with the compact low-S
 * signature and compressed SEC1 key every conversion must produce. Each named case is re-signed
 * until it occurs.
 */
public class GenFixture {
  static final BigInteger N =
      new BigInteger("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16);
  static final BigInteger HALF_N = N.shiftRight(1);
  static final BigInteger SHORT = BigInteger.ONE.shiftLeft(248);
  static final HexFormat HEX = HexFormat.of();
  static final String DEVNET_GENESIS_HASH = "ce59db5080fc2c6d3bcf7ca90712d3c2e5e6c28f27f0dfbb9953bdb0894c03ab";

  record Signed(ECPublicKey key, byte[] message, byte[] der, BigInteger r, BigInteger s) {
    BigInteger lowS() {
      return s.compareTo(HALF_N) > 0 ? N.subtract(s) : s;
    }
  }

  public static void main(String[] args) throws Exception {
    byte[] programId = new byte[32];
    Arrays.fill(programId, (byte) 0xb0);
    MessageDigest sha256 = MessageDigest.getInstance("SHA-256");
    sha256.update("BUCKSPAY:v1:note".getBytes(StandardCharsets.US_ASCII));
    sha256.update(HEX.parseHex(DEVNET_GENESIS_HASH));
    sha256.update(programId);
    byte[] domain = sha256.digest();

    Map<String, Predicate<Signed>> cases = new LinkedHashMap<>();
    cases.put("low_s", s -> s.s.compareTo(HALF_N) <= 0 && s.r.compareTo(SHORT) >= 0 && s.s.compareTo(SHORT) >= 0);
    cases.put("high_s", s -> s.s.compareTo(HALF_N) > 0 && s.r.compareTo(SHORT) >= 0 && s.lowS().compareTo(SHORT) >= 0);
    cases.put("short_r", s -> s.r.compareTo(SHORT) < 0);
    cases.put("short_s", s -> s.s.compareTo(SHORT) < 0);
    cases.put("short_s_after_normalisation", s -> s.s.compareTo(HALF_N) > 0 && s.lowS().compareTo(SHORT) < 0);
    for (int i = 0; i < 11; i++) cases.put("random_" + i, s -> true);

    KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
    generator.initialize(new ECGenParameterSpec("secp256r1"));
    SecureRandom random = new SecureRandom();
    StringBuilder json = new StringBuilder("{\n  \"domain\": \"" + HEX.formatHex(domain) + "\",\n  \"cases\": [");
    String separator = "\n";
    for (Map.Entry<String, Predicate<Signed>> entry : cases.entrySet()) {
      KeyPair pair = generator.generateKeyPair();
      Signed signed;
      do {
        byte[] message = new byte[96];
        random.nextBytes(message);
        System.arraycopy(domain, 0, message, 0, 32);
        signed = sign(pair, message);
      } while (!entry.getValue().test(signed));
      json.append(separator).append(caseJson(entry.getKey(), signed));
      separator = ",\n";
    }
    System.out.print(json.append("\n  ]\n}\n"));
  }

  static Signed sign(KeyPair pair, byte[] message) throws Exception {
    Signature signer = Signature.getInstance("SHA256withECDSA");
    signer.initSign(pair.getPrivate());
    signer.update(message);
    byte[] der = signer.sign();
    int rLength = der[3];
    int sLength = der[5 + rLength];
    BigInteger r = new BigInteger(1, Arrays.copyOfRange(der, 4, 4 + rLength));
    BigInteger s = new BigInteger(1, Arrays.copyOfRange(der, 6 + rLength, 6 + rLength + sLength));
    return new Signed((ECPublicKey) pair.getPublic(), message, der, r, s);
  }

  static String caseJson(String name, Signed signed) {
    BigInteger y = signed.key.getW().getAffineY();
    String sec1 = (y.testBit(0) ? "03" : "02") + fixed32(signed.key.getW().getAffineX());
    return String.format(
        "    {\"name\": \"%s\", \"spki\": \"%s\", \"message\": \"%s\", \"der\": \"%s\", \"high_s\": %b,"
            + " \"compact\": \"%s\", \"sec1\": \"%s\"}",
        name,
        HEX.formatHex(signed.key.getEncoded()),
        HEX.formatHex(signed.message),
        HEX.formatHex(signed.der),
        signed.s.compareTo(HALF_N) > 0,
        fixed32(signed.r) + fixed32(signed.lowS()),
        sec1);
  }

  static String fixed32(BigInteger value) {
    return String.format("%064x", value);
  }
}
