import org.gradle.internal.os.OperatingSystem

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
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

    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}")
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
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
    inputs.dir(rustRoot.resolve("transport"))
    outputs.dir(jniLibsDir)
}

val generateUniffiBindings by tasks.registering(Exec::class) {
    group = "rust"
    description = "Generuje wiązania Kotlina z metadanych zbudowanej biblioteki"
    dependsOn(buildRustLibs)

    // Bindingi czytamy z biblioteki hosta, a nie z artefaktu androidowego:
    // metadane UniFFI są identyczne, a plik hosta zawsze da się otworzyć
    // narzędziem działającym na tej maszynie.
    val rozszerzenie = if (OperatingSystem.current().isMacOsX) "dylib" else "so"
    val biblioteka = rustRoot.resolve("target/release/libmekamb_ffi.$rozszerzenie")

    workingDir = rustRoot
    commandLine(
        "cargo", "run", "--release", "-p", "mekamb-ffi", "--bin", "uniffi-bindgen", "--",
        "generate", "--library", biblioteka.absolutePath,
        "--language", "kotlin",
        "--out-dir", generatedKotlin.get().asFile.absolutePath,
        "--no-format",
    )

    outputs.dir(generatedKotlin)
}

android.sourceSets.getByName("main") {
    kotlin.srcDir(generatedKotlin)
}

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureAll {
    dependsOn(generateUniffiBindings)
}
