# JNA i kod generowany przez UniFFI odwołują się do klas przez refleksję,
# więc obfuskacja zerwałaby wiązanie z biblioteką natywną.
-keep class com.sun.jna.** { *; }
-keep class uniffi.** { *; }
-dontwarn java.awt.**
