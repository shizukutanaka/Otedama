# Legacy and Ignored Code (非ビルド対象コード)

This directory documents files guarded by build tags (ignore/legacy_*) that are excluded from normal builds. They remain for reference and future migration. You can safely move or archive them here to keep the active codebase clear.

このディレクトリは、ビルドタグ（ignore/legacy_*）で通常ビルドから除外されるファイルの情報をまとめています。参照や将来的な移行のために残しています。アクティブなコードを見やすく保つため、ここへ移動・アーカイブして問題ありません。

## Identified legacy/ignored files

- internal/security/enhanced_security.go  //go:build ignore
- internal/proxy/mining_proxy.go          //go:build ignore
- internal/mining/unified_algorithms.go   //go:build ignore
- internal/api/gateway.go                 //go:build ignore
- internal/api/health_handler.go          //go:build ignore
- internal/api/middleware.go              //go:build ignore
- internal/api/websocket_manager.go       //go:build ignore
- internal/api/realtime_handler.go        //go:build ignore
- internal/p2p/network.go                 //go:build legacy_p2p
- cmd/otedama/main.go                     //go:build legacy_main
- cmd/otedama/app.go                      //go:build ignore

## Guidance

- Keep these files out of production builds. They are experimental, legacy, or superseded.
- Prefer canonical types and implementations in:
  - internal/auth/authentication.go (AuthConfig)
  - internal/security/access_control.go (RateLimiter)
  - internal/api/websocket_auth.go (WSAuthConfig, WSAuthRateLimiter)
  - internal/api/mobile/mobile_api.go (MobileRateLimiter)
- When modernizing, migrate any needed functionality into maintained packages and remove the build tag from the new code only.

## Suggested next steps

- Move the above files into this directory tree (preserving package paths if desired) or keep them in place but referenced here.
- Add file header comments stating: "Legacy/ignored; do not include in production builds."
- Track deletions/archives in CHANGELOG for clarity.
