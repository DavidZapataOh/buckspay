package xyz.buckspay.nearby

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test

class HexTest {
  @Test
  fun roundTripsTheAdvertisedInfo() {
    val info = byteArrayOf(0x01, 0x4b, 0x37, 0x4d, 0x32)
    assertEquals("014b374d32", info.toHex())
    assertArrayEquals(info, "014b374d32".hexToBytes())
  }

  @Test
  fun keepsHighBytesUnsigned() {
    assertEquals("00ff80", byteArrayOf(0, -1, -128).toHex())
    assertArrayEquals(byteArrayOf(0, -1, -128), "00ff80".hexToBytes())
  }

  @Test
  fun refusesOddOrNonHexInput() {
    assertThrows(IllegalArgumentException::class.java) { "abc".hexToBytes() }
    assertThrows(NumberFormatException::class.java) { "zz".hexToBytes() }
  }
}

class FailureCodeTest {
  @Test
  fun mapsTheStatusesTheDocumentationNames() {
    assertEquals("RadioOff", failureCode(8007))
    assertEquals("RadioOff", failureCode(8025))
    assertEquals("AlreadyActive", failureCode(8001))
    assertEquals("AlreadyActive", failureCode(8002))
    assertEquals("AlreadyActive", failureCode(8050))
    assertEquals("Unsupported", failureCode(17))
  }

  @Test
  fun mapsEveryMissingPermissionStatus() {
    for (status in 8029..8039) assertEquals("PermissionMissing", failureCode(status))
  }

  @Test
  fun treatsEverythingElseAsFailed() {
    for (status in listOf(0, 13, 8003, 8004, 8028, 8040, 8060)) assertEquals("Failed", failureCode(status))
  }
}

class RequiredPermissionsTest {
  private val location = "android.permission.ACCESS_FINE_LOCATION"
  private val bluetooth =
    listOf("BLUETOOTH_SCAN", "BLUETOOTH_ADVERTISE", "BLUETOOTH_CONNECT").map { "android.permission.$it" }

  @Test
  fun androidThirteenAndNewerAskForNearbyDevicesAndNoLocation() {
    for (sdk in listOf(33, 34, 35, 36)) {
      assertEquals(bluetooth + "android.permission.NEARBY_WIFI_DEVICES", requiredPermissions(sdk))
    }
  }

  @Test
  fun androidTwelveAsksForBluetoothAndLocationOnlyOnApi31() {
    assertEquals(bluetooth + location, requiredPermissions(31))
    assertEquals(bluetooth, requiredPermissions(32))
  }

  @Test
  fun androidTenAndElevenAskForFineLocation() {
    assertEquals(listOf(location), requiredPermissions(29))
    assertEquals(listOf(location), requiredPermissions(30))
  }

  @Test
  fun olderVersionsAskForCoarseLocation() {
    for (sdk in 24..28) assertEquals(listOf("android.permission.ACCESS_COARSE_LOCATION"), requiredPermissions(sdk))
  }

  @Test
  fun neverAsksForLocationOnAndroidThirteenAndNewer() {
    assertFalse(requiredPermissions(33).any { it.contains("LOCATION") })
  }
}

class ManifestPermissionsTest {
  private val android = "http://schemas.android.com/apk/res/android"

  private val declared: Map<String, List<String?>> by lazy {
    val document =
      javax.xml.parsers.DocumentBuilderFactory
        .newInstance()
        .apply { isNamespaceAware = true }
        .newDocumentBuilder()
        .parse(java.io.File("src/main/AndroidManifest.xml"))
    val nodes = document.getElementsByTagName("uses-permission")
    (0 until nodes.getLength())
      .map { nodes.item(it) as org.w3c.dom.Element }
      .associate { element ->
        element.getAttributeNS(android, "name").removePrefix("android.permission.") to
          listOf("minSdkVersion", "maxSdkVersion", "usesPermissionFlags").map {
            element.getAttributeNS(android, it).ifEmpty { null }
          }
      }
  }

  @Test
  fun declaresEveryPermissionNearbyConnectionsDocumentsForItsStrategy() {
    val expected =
      mapOf(
        "ACCESS_WIFI_STATE" to listOf(null, null, null),
        "CHANGE_WIFI_STATE" to listOf(null, null, null),
        "BLUETOOTH" to listOf(null, "30", null),
        "BLUETOOTH_ADMIN" to listOf(null, "30", null),
        "ACCESS_COARSE_LOCATION" to listOf(null, "28", null),
        "ACCESS_FINE_LOCATION" to listOf("29", "31", null),
        "BLUETOOTH_ADVERTISE" to listOf("31", null, null),
        "BLUETOOTH_CONNECT" to listOf("31", null, null),
        "BLUETOOTH_SCAN" to listOf("31", null, "neverForLocation"),
        "NEARBY_WIFI_DEVICES" to listOf("32", null, "neverForLocation"),
      )
    assertEquals(expected, declared)
  }
}
