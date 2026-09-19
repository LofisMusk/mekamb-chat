plugins {
    alias(libs.plugins.android.application)
    // Od AGP 9.0 obsługa Kotlina jest wbudowana — osobna wtyczka
    // `kotlin.android` jest nie tylko zbędna, ale wręcz odrzucana.
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

/**
 * Konfiguracja podpisu wydania, o ile jest czym podpisać.
 *
 * Klucz NIE leży w repozytorium — przychodzi ze zmiennych środowiskowych
 * ustawianych z sekretów GitHuba. Bez nich `assembleRelease` zbuduje APK
 * niepodpisany; workflow wydania sprawdza to i odmawia opublikowania takiego
 * pliku, bo Android odmówiłby jego instalacji.
 *
 * Podpisywanie kluczem debugowym byłoby gorsze niż brak podpisu: APK dałoby
 * się zainstalować, więc nikt by nie zauważył, że komunikator „szyfrowany
 * end-to-end" jest sygnowany kluczem, który każdy ma na dysku.
 */
val magazynKluczy: File? = System.getenv("ANDROID_KEYSTORE_PATH")?.let(::File)?.takeIf { it.exists() }

/**
 * Architektury, na które budujemy i które trafiają do APK.
 *
 * Domyślnie z `x86_64`, bo bez niego nie da się uruchomić aplikacji
 * w emulatorze. Wydanie przekazuje `-Pabi=arm64-v8a,armeabi-v7a` — x86_64
 * waży 2,7 MB, a telefony z tą architekturą praktycznie nie istnieją.
 *
 * Jedna lista steruje i budowaniem rdzenia, i pakowaniem. Rozjazd między nimi
 * dałby albo APK bez biblioteki dla zadeklarowanej architektury (aplikacja
 * wywala się przy starcie), albo bibliotekę zbudowaną na darmo.
 */
val abi = (findProperty("abi") as String?)
    ?.split(",")
    ?.map { it.trim() }
    ?.filter { it.isNotEmpty() }
    ?: listOf("arm64-v8a", "armeabi-v7a", "x86_64")

android {
    namespace = "com.mekamb.chat"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.mekamb.chat"
        minSdk = 26
        targetSdk = 36
        // Wersja pochodzi z etykiety gita przy wydaniu. Android odmawia
        // aktualizacji na niższy `versionCode`, więc musi rosnąć — workflow
        // liczy go z numeru wersji, a nie z licznika przebiegów, żeby ten sam
        // tag dał zawsze ten sam APK.
        versionCode = (findProperty("versionCode") as String?)?.toInt() ?: 1
        versionName = (findProperty("versionName") as String?) ?: "0.1.0"

        // Adres backendu. 10.0.2.2 to host widziany z emulatora; wydanie
        // nadpisuje to przez -PapiUrl=... (patrz workflow release-android).
        val apiUrl = (findProperty("apiUrl") as String?) ?: "http://10.0.2.2:8787"
        buildConfigField("String", "API_URL", "\"$apiUrl\"")

        // Bez tego APK niesie biblioteki natywne wszystkich architektur, jakie
        // ma w sobie którakolwiek zależność. JNA dokłada między innymi `mips`,
        // `mips64` i `armeabi` — wycofane z NDK w 2018 roku i nieuruchamialne
        // na żadnym dzisiejszym urządzeniu. To pół megabajta martwego balastu.
        ndk {
            abiFilters += abi
        }
    }

    signingConfigs {
        if (magazynKluczy != null) {
            create("wydanie") {
                storeFile = magazynKluczy
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            // 10.0.2.2 to host widziany z emulatora. Na fizycznym urządzeniu
            // trzeba podać adres w sieci lokalnej albo wdrożony Worker.
            isMinifyEnabled = false
        }
        release {
            // Brak konfiguracji zostawia APK niepodpisany — świadomie, patrz
            // komentarz przy `magazynKluczy`.
            signingConfig = signingConfigs.findByName("wydanie")
            isMinifyEnabled = true

            // Usuwa zasoby, do których nie prowadzi żadne odwołanie. Działa
            // tylko razem z `isMinifyEnabled`, bo to R8 ustala, co jest
            // osiągalne.
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }

    packaging {
        resources.excludes += setOf(
            "/META-INF/{AL2.0,LGPL2.1}",
            // Teksty licencji i pliki wersji zależności. Nie są nikomu
            // potrzebne w czasie działania, a same licencje AndroidX zajmują
            // 50 kB. Informacja o licencjach zostaje w repozytorium.
            "/META-INF/**/LICENSE.txt",
            "/META-INF/*.version",
            "/META-INF/*.kotlin_module",
            "DebugProbesKt.bin",
        )
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.security.crypto)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)

    // WebRTC waży swoje: biblioteka natywna dokłada kilkanaście MB do APK
    // (przy 5,4 MB wydania to zmiana rzędu wielkości). Jest to cena za
    // rozmowy A/V, których inaczej na Androidzie nie ma wcale — a klient
    // webowy ma je od dawna, więc bez tego jedna strona nigdy nie odbierze.
    implementation(libs.webrtc)

    // Parowanie drugiego urządzenia: podgląd z aparatu i dekoder kodów QR.
    // Razem około 2 MB przy 5,4 MB wydania — cena za to, że konta da się
    // używać na dwóch urządzeniach bez wysyłania historii na serwer.
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.zxing.core)

    // Wymagane przez kod generowany przez UniFFI.
    implementation(variantOf(libs.jna) { artifactType("aar") })

    debugImplementation(libs.androidx.compose.ui.tooling)

    // Testy jednostkowe na JVM. Obejmują logikę, która decyduje o utracie
    // wiadomości (potwierdzanie kopert ze skrzynki) — ta nie może być
    // sprawdzana wyłącznie ręcznie na urządzeniu.
    testImplementation(libs.junit)
}

// ---------------------------------------------------------------------------
// Integracja z rdzeniem w Rust
//
// Dwa kroki, oba muszą wykonać się PRZED kompilacją Kotlina:
//  1. cargo-ndk buduje biblioteki natywne dla architektur Androida,
//  2. uniffi-bindgen czyta metadane ze zbudowanej biblioteki i generuje Kotlin.
//
// Kolejność jest wymuszona zależnościami zadań, a nie umową — bindingi
// generowane są z artefaktu, więc nie mają jak rozjechać się z Rustem.
// ---------------------------------------------------------------------------

/**
 * Rozszerzenie biblioteki współdzielonej na maszynie budującej.
 *
 * Liczone raz i używane przez oba zadania. Wpisane na sztywno `dylib` działało
 * tylko na macOS — w CI na Linuksie zadeklarowany wynik nigdy by nie powstał,
 * więc Gradle uznawałby zadanie za wiecznie nieaktualne.
 */
val hostLibExt = when {
    System.getProperty("os.name").startsWith("Mac") -> "dylib"
    System.getProperty("os.name").startsWith("Windows") -> "dll"
    else -> "so"
}

/**
 * PATH, w którym na pewno jest `cargo` i `cargo-ndk`.
 *
 * Android Studio uruchomione z Docka nie czyta `.zshrc`, więc dostaje goły
 * systemowy PATH — z terminala build działał, z IDE padał na „Cannot run
 * program cargo". Dokładamy typowe miejsca instalacji (rustup ze skryptu,
 * rustup i rust z Homebrew) zamiast wymagać od każdego konfigurowania IDE.
 * `~/.cargo/bin` jest potrzebne także wtedy, gdy samo `cargo` leży gdzie
 * indziej: tam `cargo install` kładzie `cargo-ndk`.
 */
val rustPath: String = run {
    val dom = System.getProperty("user.home")
    val dodatkowe = listOfNotNull(
        System.getenv("CARGO_HOME")?.let { "$it/bin" },
        "$dom/.cargo/bin",
        "/opt/homebrew/opt/rustup/bin",
        "/opt/homebrew/bin",
        "/usr/local/opt/rustup/bin",
        "/usr/local/bin",
    )
    (dodatkowe + (System.getenv("PATH") ?: "").split(File.pathSeparator))
        .filter { it.isNotBlank() }
        .distinct()
        .joinToString(File.pathSeparator)
}

/** Bezwzględna ścieżka do `cargo` — `commandLine` szuka programu w PATH Gradle'a, nie w `environment`. */
val cargo: String = rustPath.split(File.pathSeparator)
    .map { File(it, "cargo") }
    .firstOrNull { it.canExecute() }
    ?.absolutePath
    ?: "cargo"

val rustRoot = rootProject.file("..")
val jniLibsDir = layout.projectDirectory.dir("src/main/jniLibs")
val generatedKotlin = layout.buildDirectory.dir("generated/uniffi")

val buildRustLibs by tasks.registering(Exec::class) {
    group = "rust"
    description = "Buduje rdzeń Rust dla architektur Androida (wymaga NDK i cargo-ndk)"

    // Katalog jest wynikiem tego zadania, ale cargo-ndk tylko dokłada do niego
    // pliki. Po usunięciu zależności jej biblioteka zostawała tu na zawsze
    // i trafiała do APK — tak przez pewien czas jechało 624 kB po `iroh`,
    // wymienionym na własny transport. W CI tego nie widać, bo checkout jest
    // czysty; widać dopiero w wydaniu zbudowanym lokalnie.
    doFirst {
        jniLibsDir.asFile.deleteRecursively()
    }

    workingDir = rustRoot
    environment("PATH", rustPath)
    commandLine(
        buildList {
            add(cargo)
            add("ndk")
            abi.forEach { add("-t"); add(it) }
            add("-o"); add(jniLibsDir.asFile.absolutePath)
            add("build")
            add("--release")
            add("-p"); add("mekamb-ffi")
        },
    )

    inputs.dir(rustRoot.resolve("core"))
    inputs.dir(rustRoot.resolve("opaque"))
    inputs.dir(rustRoot.resolve("transport"))
    outputs.dir(jniLibsDir)
}

/**
 * Buduje bibliotekę dla hosta — wyłącznie po to, żeby odczytać z niej metadane.
 *
 * Naturalne byłoby czytać je z pliku, który trafia do APK. Nie da się: profil
 * `release` usuwa sekcję z metadanymi UniFFI przy strippingu, a artefakty
 * androidowe budujemy właśnie w tym profilu.
 *
 * Ryzyko rozjazdu jest tu żadne — obie biblioteki powstają z tego samego
 * źródła w jednym przebiegu builda.
 */
val buildHostLib by tasks.registering(Exec::class) {
    group = "rust"
    description = "Buduje rdzeń dla hosta, żeby odczytać metadane UniFFI"

    workingDir = rustRoot
    environment("PATH", rustPath)
    commandLine(cargo, "build", "-p", "mekamb-ffi")

    inputs.dir(rustRoot.resolve("core"))
    inputs.dir(rustRoot.resolve("opaque"))
    inputs.dir(rustRoot.resolve("transport"))
    outputs.file(rustRoot.resolve("target/debug/libmekamb_ffi.$hostLibExt"))
}

val generateUniffiBindings by tasks.registering(Exec::class) {
    group = "rust"
    description = "Generuje wiązania Kotlina z metadanych zbudowanej biblioteki"
    dependsOn(buildRustLibs, buildHostLib)

    val biblioteka = rustRoot.resolve("target/debug/libmekamb_ffi.$hostLibExt")

    workingDir = rustRoot
    environment("PATH", rustPath)
    commandLine(
        cargo, "run", "-p", "mekamb-ffi", "--bin", "uniffi-bindgen", "--",
        "generate", "--library", biblioteka.absolutePath,
        "--language", "kotlin",
        "--out-dir", generatedKotlin.get().asFile.absolutePath,
        "--no-format",
    )

    // Zadanie jest ZAWSZE uruchamiane ponownie. Śledzenie wejść okazało się
    // zawodne: przy nieaktualnych wiązaniach Kotlin zgłasza niezgodność typów,
    // co wygląda jak błąd w kodzie aplikacji, choć siedzi w konfiguracji
    // builda. Dwukrotnie zmyliło to diagnozę i nie warto ryzykować trzeciego.
    //
    // Koszt jest znikomy: uniffi-bindgen czyta tylko metadane z gotowej
    // biblioteki, a kompilację Rusta i tak buforuje cargo.
    outputs.upToDateWhen { false }
    outputs.dir(generatedKotlin)
}

// jniLibs jest jednocześnie katalogiem źródeł i wynikiem zadania budującego
// rdzeń. Bez jawnej zależności Gradle nie wie, w jakiej kolejności je wykonać,
// i zgłasza to jako problem konfiguracji.
tasks.matching { it.name.contains("JniLibFolders") || it.name.contains("MergeNativeLibs") }
    .configureEach { dependsOn(buildRustLibs) }

// Wygenerowany Kotlin dokładamy do źródeł modułu.
android.sourceSets.getByName("main") {
    kotlin.directories.add(generatedKotlin.get().asFile.absolutePath)
}

// Kompilacja Kotlina musi poczekać na wygenerowanie wiązań. Wiążemy się z
// nazwą zadania, a nie z typem `KotlinCompile`: od AGP 9 obsługa Kotlina jest
// wbudowana i ten typ nie jest już widoczny w skrypcie budowania.
tasks.matching { it.name.startsWith("compile") && it.name.contains("Kotlin") }
    .configureEach { dependsOn(generateUniffiBindings) }

// ---------------------------------------------------------------------------
// Uruchamianie z Android Studio
// ---------------------------------------------------------------------------

/**
 * Włącza zainstalowaną aplikację na każdym podłączonym urządzeniu.
 *
 * Potrzebne konfiguracjom z `android/.run/` (emulator, dev, release): backend
 * wybiera się przez `-PapiUrl`, a zwykła konfiguracja „app" nie ma gdzie
 * przyjąć parametru Gradle'a — więc te konfiguracje są zadaniami Gradle'a
 * (`installDebug` + to), a Gradle sam z siebie po instalacji niczego nie
 * uruchamia. Flavory dałyby to samo przez „Build Variants", ale zmieniają
 * nazwy zadań (`assembleProdRelease`), na których stoją workflowy i instrukcje.
 */
val uruchomAplikacje by tasks.registering {
    group = "uruchamianie"
    description = "Uruchamia zainstalowaną aplikację na podłączonych urządzeniach"
    mustRunAfter("installDebug")

    val adb = androidComponents.sdkComponents.adb
    val aktywnosc = "${android.defaultConfig.applicationId}/com.mekamb.chat.MainActivity"
    doLast {
        val adbPath = adb.get().asFile.absolutePath
        fun uruchom(vararg argumenty: String): String {
            val proces = ProcessBuilder(adbPath, *argumenty).redirectErrorStream(true).start()
            val wynik = proces.inputStream.bufferedReader().readText()
            check(proces.waitFor() == 0) { "adb ${argumenty.joinToString(" ")}: $wynik" }
            return wynik
        }
        val urzadzenia = uruchom("devices").lines().drop(1)
            .map { it.split("\t") }
            .filter { it.size == 2 && it[1].trim() == "device" }
            .map { it[0] }
        check(urzadzenia.isNotEmpty()) { "Brak podłączonego urządzenia ani uruchomionego emulatora." }
        urzadzenia.forEach { numer ->
            uruchom("-s", numer, "shell", "am", "start", "-n", aktywnosc)
            logger.lifecycle("Uruchomiono na $numer")
        }
    }
}
