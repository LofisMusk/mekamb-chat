plugins {
    alias(libs.plugins.android.application)
    // Od AGP 9.0 obsługa Kotlina jest wbudowana — osobna wtyczka
    // `kotlin.android` jest nie tylko zbędna, ale wręcz odrzucana.
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.mekamb.chat"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.mekamb.chat"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"

        // Adres backendu. Nadpisywany przy budowaniu wydania.
        buildConfigField("String", "API_URL", "\"http://10.0.2.2:8787\"")
    }

    buildTypes {
        debug {
            // 10.0.2.2 to host widziany z emulatora. Na fizycznym urządzeniu
            // trzeba podać adres w sieci lokalnej albo wdrożony Worker.
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = true
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
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}")
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

    // Wymagane przez kod generowany przez UniFFI.
    implementation(variantOf(libs.jna) { artifactType("aar") })

    debugImplementation(libs.androidx.compose.ui.tooling)
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

/** Architektury, na które budujemy. */
val abi = listOf("arm64-v8a", "armeabi-v7a", "x86_64")

val rustRoot = rootProject.file("..")
val jniLibsDir = layout.projectDirectory.dir("src/main/jniLibs")
val generatedKotlin = layout.buildDirectory.dir("generated/uniffi")

val buildRustLibs by tasks.registering(Exec::class) {
    group = "rust"
    description = "Buduje rdzeń Rust dla architektur Androida (wymaga NDK i cargo-ndk)"

    workingDir = rustRoot
    commandLine(
        buildList {
            add("cargo")
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
    commandLine("cargo", "build", "-p", "mekamb-ffi")

    // Katalog z bindingami MUSI tu być. Bez niego zmiana w warstwie UniFFI
    // nie unieważnia zadania, Gradle uznaje je za aktualne i kompiluje Kotlin
    // przeciw nieaktualnym wiązaniom — błąd wygląda wtedy jak problem
    // w kodzie Kotlina, choć jest w konfiguracji builda.
    inputs.dir(rustRoot.resolve("core"))
    inputs.dir(rustRoot.resolve("opaque"))
    inputs.dir(rustRoot.resolve("transport"))
}

val generateUniffiBindings by tasks.registering(Exec::class) {
    group = "rust"
    description = "Generuje wiązania Kotlina z metadanych zbudowanej biblioteki"
    dependsOn(buildRustLibs, buildHostLib)

    val rozszerzenie = if (System.getProperty("os.name").startsWith("Mac")) "dylib" else "so"
    val biblioteka = rustRoot.resolve("target/debug/libmekamb_ffi.$rozszerzenie")

    workingDir = rustRoot
    commandLine(
        "cargo", "run", "-p", "mekamb-ffi", "--bin", "uniffi-bindgen", "--",
        "generate", "--library", biblioteka.absolutePath,
        "--language", "kotlin",
        "--out-dir", generatedKotlin.get().asFile.absolutePath,
        "--no-format",
    )

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
