fn main() {
    // The release tag this build was cut from, read by the update check
    // (`option_env!("LITHIC_BUILD_TAG")`). Handed to rustc explicitly rather than
    // left to the ambient environment, and declared here, because the release job
    // restores a cached target directory: without this a cached `lithic` could be
    // judged fresh and the shipped exe would carry a previous release's tag (or
    // none at all), which reads to the app as "this build is current" forever.
    if let Ok(tag) = std::env::var("LITHIC_BUILD_TAG") {
        println!("cargo:rustc-env=LITHIC_BUILD_TAG={tag}");
    }
    println!("cargo:rerun-if-env-changed=LITHIC_BUILD_TAG");
    tauri_build::build()
}
