// Windows: release 构建下切到 GUI(windows)子系统,否则进程默认挂在 console
// 子系统 —— 双击启动时系统会额外弹一个黑色控制台窗口(与 sidecar 无关,是主
// 进程自身的)。debug 下保留 console 以便看 stdout/日志。
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

fn main() {
    taco_desktop_lib::run()
}
