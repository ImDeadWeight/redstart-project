//! A Windows Job Object that ends the daemon's whole process tree when this
//! shell's handle to it closes, which happens however the shell exits,
//! including a crash or Task Manager's End task.
//!
//! This closes T1's carried gap: a daemon wedged badly enough not to read its
//! pipe would outlive a crashed shell and keep the ports. llama-server is a
//! child of the daemon and inherits the job, so it goes too.
//!
//! The deliberate paths are still graceful (`shutdown` on the pipe, then
//! wait). The job matters only when the shell can no longer ask. Stale-pid
//! reaping at the next start covers what a hard kill leaves behind.

#[cfg(windows)]
mod imp {
    use std::ptr::null;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(HANDLE);

    // The handle is a kernel object reference, safe to use from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new() -> Result<Job, String> {
            let h = unsafe { CreateJobObjectW(null(), null()) };
            if h.is_null() {
                return Err("CreateJobObjectW failed".into());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = unsafe {
                SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if ok == 0 {
                unsafe { CloseHandle(h) };
                return Err("SetInformationJobObject failed".into());
            }
            Ok(Job(h))
        }

        /// `process` is a raw process handle (Child::as_raw_handle()).
        pub fn assign(&self, process: *mut std::ffi::c_void) -> Result<(), String> {
            if unsafe { AssignProcessToJobObject(self.0, process as HANDLE) } == 0 {
                return Err("AssignProcessToJobObject failed".into());
            }
            Ok(())
        }

        /// Ends every process in the job now: the stop timeout's last resort.
        pub fn terminate(&self) {
            unsafe { TerminateJobObject(self.0, 1) };
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub struct Job;
    impl Job {
        pub fn new() -> Result<Job, String> {
            Ok(Job)
        }
        pub fn assign(&self, _: *mut std::ffi::c_void) -> Result<(), String> {
            Ok(())
        }
        pub fn terminate(&self) {}
    }
}

pub use imp::Job;
