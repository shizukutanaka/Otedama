{
  "targets": [
    {
      "target_name": "otedama_native",
      "sources": [
        "src/mining_core.cpp",
        "src/sha256.cpp",
        "src/scrypt.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "cflags": [ "-O3", "-march=native" ],
      "cflags_cc": [ "-O3", "-march=native" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "conditions": [
        ["OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "Optimization": 2,
              "FavorSizeOrSpeed": 1,
              "InlineFunctionExpansion": 2,
              "EnableIntrinsicFunctions": "true"
            }
          }
        }],
        ["OS=='mac'", {
          "xcode_settings": {
            "GCC_OPTIMIZATION_LEVEL": "3",
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LIBRARY": "libc++",
            "MACOSX_DEPLOYMENT_TARGET": "10.15"
          }
        }]
      ]
    }
  ]
}