// @ts-nocheck
import { useState, useEffect } from "react";
import { Play, Pause, Search, Plus, MoreVertical, RefreshCw, ChevronLeft, ChevronRight, Check } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { check } from "@tauri-apps/plugin-updater";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { listen } from "@tauri-apps/api/event";
import { GoogleOAuthProvider } from '@react-oauth/google';
import "./App.css";

function App() {
  // Auto-Updater Check
  useEffect(() => {
    async function checkForUpdates() {
      try {
        const update = await check();
        if (update) {
          console.log(`Update available: ${update.version}`);
          await update.downloadAndInstall();
          // Ask Tauri to restart the app (requires importing relaunch from @tauri-apps/plugin-process or simply alert user)
          alert("A new update has been installed! Please restart the app.");
        }
      } catch (err) {
        console.error("Failed to check for updates:", err);
      }
    }
    checkForUpdates();
  }, []);

  const handleDeepLinkToken = async (token: string) => {
    setIsAuthLoading(true);
    try {
      const res = await fetch(`${import.meta.env.VITE_API_BASE_URL}/auth/me`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const employee = await res.json();
        localStorage.setItem("authToken", token);
        localStorage.setItem("loginTimestamp", new Date().toISOString());
        
        setToken(token);
        setUser(employee);
        
        let role = "Employee";
        if (employee.role === 'admin' || employee.role === 'SuperAdmin') role = "Admin";
        else if (employee.role === 'project-manager') role = "PM";
        
        setUserRole(role as "Admin" | "PM" | "Employee");
        setIsAuthenticated(true);
        fetchProjects(token);
        fetchAttendanceStatus(token);
      } else {
        alert("Authentication failed. Please try again.");
      }
    } catch (e) {
      alert("Network error authenticating via deep link");
    } finally {
      setIsAuthLoading(false);
    }
  };

  // Deep-Link Listener
  useEffect(() => {
    // 1. Standard Tauri v2 deep-link plugin listener
    const unlisten = onOpenUrl(async (urls) => {
      console.log('Deep link opened (onOpenUrl):', urls);
      for (const url of urls) {
        if (url.includes('token=')) {
          const token = url.split('token=')[1];
          if (token) {
             handleDeepLinkToken(token);
          }
        }
      }
    });

    // 2. Fallback listener directly from single-instance event (for Windows)
    const unlistenEvent = listen<string[]>('deep-link-received', (event) => {
      console.log('Deep link opened (single-instance event):', event.payload);
      for (const arg of event.payload) {
        if (arg.includes('token=')) {
          const token = arg.split('token=')[1];
          if (token) {
             handleDeepLinkToken(token);
          }
        }
      }
    });

    return () => {
      unlisten.then(fn => fn());
      unlistenEvent.then(fn => fn());
    };
  }, []);
  const [userRole, setUserRole] = useState<"Admin" | "PM" | "Employee">("Admin");
  
  // State for Authentication
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [authMode, setAuthMode] = useState<"login" | "signup">("login");
  const [isAuthLoading, setIsAuthLoading] = useState<boolean>(false);
  const [isMenuOpen, setIsMenuOpen] = useState<boolean>(false);

  // State for Check-in flow
  const [isCheckedIn, setIsCheckedIn] = useState<boolean>(false);
  const [currentRealTime, setCurrentRealTime] = useState<Date>(new Date());
  
  // Shift tracking
  const [checkInTime, setCheckInTime] = useState<Date | null>(null);
  const [accumulatedShiftSeconds, setAccumulatedShiftSeconds] = useState<number>(0);
  const [lastActiveDateString, setLastActiveDateString] = useState<string>(new Date().toDateString());

  // Last updated state (when a project completes)
  const [lastProjectCompletedAt, setLastProjectCompletedAt] = useState<Date | null>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = new Date();
      setCurrentRealTime(now);
      
      setLastActiveDateString(prev => {
        const currentString = now.toDateString();
        if (prev !== currentString) {
          setAccumulatedShiftSeconds(0);
          return currentString;
        }
        return prev;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const formatRealTime = (date: Date) => {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const currentShiftSeconds = checkInTime ? Math.floor((currentRealTime.getTime() - checkInTime.getTime()) / 1000) : 0;
  const totalWorkedSeconds = accumulatedShiftSeconds + currentShiftSeconds;

  const [activeAttendanceLogId, setActiveAttendanceLogId] = useState<string | null>(null);

  const handleCheckIn = async () => {
    setCheckInTime(new Date());
    setIsCheckedIn(true);
    
    try {
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/attendance/check-in`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}` 
        },
        body: JSON.stringify({ employeeId: user?.id })
      });
      const data = await response.json();
      setActiveAttendanceLogId(data.attendanceLogId);
    } catch (error) {
      console.error('Failed to check in', error);
    }
  };

  const handleCheckOut = async () => {
    // Optimistic UI updates
    if (checkInTime) {
      setAccumulatedShiftSeconds(prev => prev + Math.floor((new Date().getTime() - checkInTime.getTime()) / 1000));
    }
    setCheckInTime(null);
    setIsCheckedIn(false);
    
    // Call backend to checkout
    if (activeAttendanceLogId) {
      try {
        await fetch(`${import.meta.env.VITE_API_BASE_URL}/attendance/check-out`, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}` 
          },
          body: JSON.stringify({ attendanceLogId: activeAttendanceLogId })
        });
        setActiveAttendanceLogId(null);
        // Resync perfectly with server
        if (token) fetchAttendanceStatus(token);
      } catch (error) {
        console.error('Failed to check out', error);
      }
    }

    // Also pause the active task timer if running
    stopBackendTimer();
  };


  // State for which project's tasks to show in the main To-do list (null means 'All')
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  // State for the currently active/selected task
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // Timer state
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [taskTimes, setTaskTimes] = useState<Record<string, number>>({});
  const [activeTimeLogId, setActiveTimeLogId] = useState<string | null>(null);

  const startBackendTimer = async (taskId: string) => {
    try {
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/time-logs/start`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}` 
        },
        body: JSON.stringify({
          employeeId: user?.id,
          taskId: taskId
        })
      });
      const data = await response.json();
      setActiveTimeLogId(data.timeLogId);
      setIsPlaying(true);
      
      // Update task status to "In Progress"
      if (token) {
        fetch(`http://localhost:3002/api/tasks/${taskId}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ status: 'In Progress' })
        }).catch(console.error);
      }
    } catch (error) {
      console.error('Failed to start timer', error);
    }
  };

  const stopBackendTimer = async () => {
    if (!activeTimeLogId) {
      setIsPlaying(false);
      return;
    }
    try {
      await fetch(`${import.meta.env.VITE_API_BASE_URL}/time-logs/stop`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}` 
        },
        body: JSON.stringify({ timeLogId: activeTimeLogId })
      });
      setActiveTimeLogId(null);
      setIsPlaying(false);
    } catch (error) {
      console.error('Failed to stop timer', error);
    }
  };

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (isPlaying && selectedTaskId) {
      interval = setInterval(() => {
        setTaskTimes(prev => ({
          ...prev,
          [selectedTaskId]: (prev[selectedTaskId] || 0) + 1
        }));
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isPlaying, selectedTaskId]);

  const currentTaskTime = selectedTaskId ? (taskTimes[selectedTaskId] || 0) : 0;

  const formatTime = (totalSeconds: number) => {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    
    return [
      hours.toString().padStart(2, '0'),
      minutes.toString().padStart(2, '0'),
      seconds.toString().padStart(2, '0')
    ].join(':');
  };

  const canCreate = userRole === "Admin" || userRole === "PM";

  const [projects, setProjects] = useState([
    {
      id: 1,
      name: "Website Redesign",
      tasks: [
        { id: 101, name: "Frontend Development", time: "0:00", created: "06/27/2024 09:43 AM", isCompleted: false },
        { id: 102, name: "UI/UX Design", time: "2:15", created: "06/27/2024 09:41 AM", isCompleted: false },
        { id: 103, name: "Backend APIs", time: "1:05", created: "06/28/2024 10:00 AM", isCompleted: false }
      ]
    },
    {
      id: 2,
      name: "Mobile App",
      tasks: [
        { id: 201, name: "API Integration", time: "0:00", created: "06/27/2024 09:41 AM", isCompleted: false },
        { id: 202, name: "Push Notifications", time: "1:30", created: "06/27/2024 10:05 AM", isCompleted: false },
        { id: 203, name: "App Store Deployment", time: "0:00", created: "06/29/2024 11:05 AM", isCompleted: false }
      ]
    }
  ]);

  const handleProjectClick = (projectId: string) => {
    // Set the main view to show this project's tasks
    setSelectedProjectId(projectId);

    // Auto-select the first task of this project if the currently selected task isn't in it
    const project = projects.find(p => p.id === projectId);
    if (project && project.tasks.length > 0) {
      const isCurrentTaskInProject = project.tasks.some(t => t.id === selectedTaskId);
      if (!isCurrentTaskInProject) {
        setSelectedTaskId(project.tasks[0].id);
      }
    }
  };

  const handleTaskClick = (taskId: string, projectId: string) => {
    setSelectedTaskId(taskId);
    // Optionally also set the project as selected when a task is clicked directly
    setSelectedProjectId(projectId);
    // Pause timer when switching tasks
    stopBackendTimer();
  };

  const handleCompleteTask = () => {
    if (!selectedTaskId) return;

    // Reset timer for this specific task
    stopBackendTimer();
    setTaskTimes(prev => ({ ...prev, [selectedTaskId]: 0 }));

    if (token) {
      fetch(`http://localhost:3002/api/tasks/${selectedTaskId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ status: 'Done' })
      }).catch(console.error);
    }

    // Mark task as completed and check for project completion
    setProjects(prevProjects => {
      let projectJustCompleted = false;
      
      const newProjects = prevProjects.map(proj => {
        const taskIndex = proj.tasks.findIndex(t => t.id === selectedTaskId);
        if (taskIndex !== -1) {
          const newTasks = [...proj.tasks];
          newTasks[taskIndex] = { ...newTasks[taskIndex], isCompleted: true };
          
          // Check if this project is now fully completed
          if (newTasks.every(t => t.isCompleted)) {
            projectJustCompleted = true;
          }
          
          return { ...proj, tasks: newTasks };
        }
        return proj;
      });

      if (projectJustCompleted) {
        setLastProjectCompletedAt(new Date());
      }

      return newProjects;
    });
  };

  // Get all tasks as a flat list
  const allTasks = projects.flatMap(p => p.tasks);
  
  // Get tasks for the main view based on selected project
  const displayedTasks = selectedProjectId
    ? projects.find(p => p.id === selectedProjectId)?.tasks || []
    : allTasks;

  // Get the fully active task object to display details
  const activeTask = allTasks.find(t => t.id === selectedTaskId);

  // Helper to check if a project is fully completed
  const isProjectComplete = (projectId: string) => {
    const proj = projects.find(p => p.id === projectId);
    if (!proj || proj.tasks.length === 0) return false;
    return proj.tasks.every(t => t.isCompleted);
  };

  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);

  const handleLogout = () => {
    localStorage.removeItem("authToken");
    localStorage.removeItem("loginTimestamp");
    
    // Automatically checkout if they were checked in
    if (activeAttendanceLogId && token) {
      fetch(`${import.meta.env.VITE_API_BASE_URL}/attendance/check-out`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ attendanceLogId: activeAttendanceLogId })
      }).catch(console.error);
    }
    
    setActiveAttendanceLogId(null);
    setCheckInTime(null);
    setIsCheckedIn(false);
    setToken(null);
    setUser(null);
    setIsAuthenticated(false);
  };

  useEffect(() => {
    const savedToken = localStorage.getItem("authToken");
    const loginTimestamp = localStorage.getItem("loginTimestamp");
    
    if (savedToken && loginTimestamp) {
      const loginDate = new Date(loginTimestamp);
      const now = new Date();
      const diffTime = Math.abs(now.getTime() - loginDate.getTime());
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      
      if (diffDays <= 3) {
        // Token is valid, fetch user details
        fetch(`${import.meta.env.VITE_API_BASE_URL}/auth/me`, {
          headers: { 'Authorization': `Bearer ${savedToken}` }
        })
        .then(res => res.json())
        .then(data => {
          if (data && !data.error) {
            setToken(savedToken);
            setUser(data);
            let role = "Employee";
            if (data.role === 'admin' || data.role === 'SuperAdmin') role = "Admin";
            else if (data.role === 'project-manager') role = "PM";
            setUserRole(role as "Admin" | "PM" | "Employee");
            setIsAuthenticated(true);
            // Intentionally not calling fetchAttendanceStatus/fetchProjects here, 
            // as the existing isAuthenticated useEffect will handle it once state updates
          } else {
            handleLogout();
          }
        })
        .catch(err => {
          console.error("Auto-login failed:", err);
          handleLogout();
        });
      } else {
        // Expired after 3 days
        handleLogout();
      }
    }
  }, []);

  // Handle app closing -> automatic check-out
  useEffect(() => {
    const handleUnload = () => {
      if (activeAttendanceLogId && token) {
        fetch(`${import.meta.env.VITE_API_BASE_URL}/attendance/check-out`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ attendanceLogId: activeAttendanceLogId }),
          keepalive: true
        }).catch(console.error);
      }
    };
    
    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, [activeAttendanceLogId, token]);

  const fetchProjects = async (authToken: string) => {
    try {
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/projects`, {
        headers: {
          'Authorization': `Bearer ${authToken}`
        }
      });
      if (response.ok) {
        const data = await response.json();
        const mapped = data.map((p: any) => ({
          id: p.id,
          name: p.name,
          tasks: p.tasks.map((t: any) => ({
            id: t.id,
            name: t.title,
            time: formatTime(t.timeConsumed || 0),
            created: new Date(t.createdAt).toLocaleString(),
            isCompleted: t.status === 'Done'
          }))
        })).filter((p: any) => p.tasks && p.tasks.length > 0);
        setProjects(mapped);
      }
    } catch (err) {
      console.error("Failed to fetch projects", err);
    }
  };

  const fetchAttendanceStatus = async (authToken: string) => {
    try {
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL}/attendance/status`, {
        headers: {
          'Authorization': `Bearer ${authToken}`
        }
      });
      if (response.ok) {
        const data = await response.json();
        setAccumulatedShiftSeconds(data.accumulatedShiftSeconds || 0);
        
        if (data.activeAttendanceLogId) {
          setActiveAttendanceLogId(data.activeAttendanceLogId);
          setCheckInTime(new Date(data.checkInTime));
          setIsCheckedIn(true);
        } else {
          setActiveAttendanceLogId(null);
          setCheckInTime(null);
          setIsCheckedIn(false);
        }
      }
    } catch (err) {
      console.error("Failed to fetch attendance status", err);
    }
  };

  useEffect(() => {
    if (isAuthenticated && token) {
      // Fetch once on mount/auth
      fetchAttendanceStatus(token);
      
      const interval = setInterval(() => {
        fetchProjects(token);
        fetchAttendanceStatus(token);
      }, 3000);
      return () => clearInterval(interval);
    }
  }, [isAuthenticated, token]);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsAuthLoading(true);
    const form = e.target as HTMLFormElement;
    
    let url = `${import.meta.env.VITE_API_BASE_URL}/auth/login`;
    let body: any = {
      email: (form.querySelector('input[type="email"]') as HTMLInputElement).value,
      password: (form.querySelector('input[type="password"]') as HTMLInputElement).value,
    };

    if (authMode === 'signup') {
      url = `${import.meta.env.VITE_API_BASE_URL}/auth/signup`;
      const fullName = (form.querySelector('input[type="text"]') as HTMLInputElement).value;
      const [firstName, ...rest] = fullName.split(' ');
      body.firstName = firstName;
      body.lastName = rest.join(' ') || 'User';
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      
      if (res.ok && data.token) {
        localStorage.setItem("authToken", data.token);
        localStorage.setItem("loginTimestamp", new Date().toISOString());
        
        setToken(data.token);
        setUser(data.employee);
        
        let role = "Employee";
        if (data.employee.role === 'admin' || data.employee.role === 'SuperAdmin') role = "Admin";
        else if (data.employee.role === 'project-manager') role = "PM";
        
        setUserRole(role as "Admin" | "PM" | "Employee");
        setIsAuthenticated(true);
        fetchProjects(data.token);
        fetchAttendanceStatus(data.token);
      } else {
        alert(data.error || "Authentication failed");
      }
    } catch (err) {
      alert("Network error connecting to backend");
    } finally {
      setIsAuthLoading(false);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ width: 28, height: 28, backgroundColor: 'var(--primary-blue)', borderRadius: '50%' }}></div>
              <span style={{ fontSize: '24px', fontWeight: 600 }}>Nuvio</span>
            </div>
          </div>
          <h2>{authMode === 'login' ? 'Welcome Back' : 'Create an Account'}</h2>
          <form className="auth-form" onSubmit={handleAuthSubmit}>
            {authMode === 'signup' && (
              <div className="auth-input-group">
                <label>Full Name</label>
                <input type="text" placeholder="John Doe" required />
              </div>
            )}
            <div className="auth-input-group">
              <label>Email</label>
              <input type="email" placeholder="you@example.com" required />
            </div>
            <div className="auth-input-group">
              <label>Password</label>
              <input type="password" placeholder="••••••••" required />
            </div>
            <button type="submit" className="btn-auth-submit" disabled={isAuthLoading}>
              {isAuthLoading ? 'Please wait...' : (authMode === 'login' ? 'Log In' : 'Sign Up')}
            </button>
          </form>
          
          <div style={{ marginTop: '20px', display: 'flex', justifyContent: 'center', width: '100%' }}>
             <button
                type="button"
                onClick={() => {
                   openUrl(`${import.meta.env.VITE_API_BASE_URL}/auth/google/desktop`);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '10px',
                  backgroundColor: 'white',
                  color: '#444',
                  border: '1px solid #ddd',
                  padding: '12px 24px',
                  borderRadius: '6px',
                  fontSize: '15px',
                  fontWeight: '500',
                  cursor: 'pointer',
                  width: '100%',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
                }}
             >
                <svg width="20" height="20" viewBox="0 0 24 24">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                </svg>
                Sign in with Google
             </button>
          </div>

          <div className="auth-toggle">
            {authMode === 'login' ? "Don't have an account?" : "Already have an account?"}
            <button type="button" onClick={() => setAuthMode(authMode === 'login' ? 'signup' : 'login')}>
              {authMode === 'login' ? 'Sign up' : 'Log in'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!isCheckedIn) {
    return (
      <div className="pre-checkin-screen">
        <div style={{ marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '15px' }}>
            <div style={{ width: 40, height: 40, backgroundColor: 'var(--primary-blue)', borderRadius: '50%' }}></div>
            <span style={{ fontSize: '36px', fontWeight: 600 }}>Nuvio</span>
        </div>
        <div className="real-time-clock">
          {formatRealTime(currentRealTime)}
        </div>
        {accumulatedShiftSeconds > 0 && (
          <div style={{ color: 'var(--text-gray)', fontSize: '14px', marginBottom: '15px', fontWeight: 500 }}>
            Total Worked Today: {formatTime(accumulatedShiftSeconds)}
          </div>
        )}
        <button className="btn-checkin-large" onClick={handleCheckIn}>
          Check-in
        </button>
        <button 
          onClick={handleLogout}
          style={{
            marginTop: '20px',
            background: 'none',
            border: 'none',
            color: 'var(--text-gray)',
            cursor: 'pointer',
            fontSize: '14px',
            textDecoration: 'underline'
          }}
        >
          Logout
        </button>
      </div>
    );
  }

  return (
    <div className="app-container">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-header" style={{ justifyContent: 'space-between', paddingRight: '15px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {/* Logo Placeholder */}
            <div style={{ width: 20, height: 20, backgroundColor: 'var(--primary-blue)', borderRadius: '50%' }}></div>
            <span>Nuvio</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-gray)' }}>
              {formatRealTime(currentRealTime)}
            </span>
            <button 
              onClick={handleCheckOut}
              style={{ padding: '6px 12px', backgroundColor: 'white', color: 'var(--text-dark)', border: '1px solid var(--border-color)', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}
            >
              Check-out
            </button>
          </div>
        </div>

        <div className="timer-section">
          <div className="timer-display">
            {formatTime(currentTaskTime)}
          </div>
          <div className="current-user-info">
            <h2>{userRole}</h2>
            {user && <p style={{ fontSize: '0.9rem', color: '#64748b', marginBottom: '8px', marginTop: '-4px' }}>{user.firstName} {user.lastName}</p>}
            <p>{activeTask ? activeTask.name : 'No task selected'}</p>
          </div>
          <button className="play-button-big" onClick={() => isPlaying ? stopBackendTimer() : (selectedTaskId && startBackendTimer(selectedTaskId))}>
            {isPlaying ? <Pause size={24} fill="white" /> : <Play size={24} fill="white" />}
          </button>
          
          <div className="timer-stats">
            <span>No limits</span>
            <span title="Total Worked Time">Today: {formatTime(totalWorkedSeconds)}</span>
          </div>
        </div>

        <div className="search-bar-sidebar">
          <Search size={16} color="var(--text-gray)" />
          <input type="text" placeholder="adm" defaultValue="adm" />
        </div>

        <div className="project-section">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '15px', color: 'var(--text-gray)', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>
            <span>Assigned Projects</span>
          </div>
          
          {projects.map(project => {
            const isCompleted = isProjectComplete(project.id);
            const isSelected = selectedProjectId === project.id;
            
            // Determine background color
            let bgColor = '#f1f3f4';
            if (isCompleted) {
              bgColor = '#d4edda'; // Light green if all tasks complete
            } else if (isSelected) {
              bgColor = '#e8eaed';
            }

            return (
              <div key={project.id}>
                <div 
                  className="project-item" 
                  style={{ 
                    cursor: 'pointer', 
                    backgroundColor: bgColor,
                    color: isCompleted ? '#155724' : 'inherit',
                    borderLeft: isCompleted ? '4px solid #28a745' : 'none'
                  }}
                  onClick={() => handleProjectClick(project.id)}
                >
                  <span>{project.name}</span>
                  {isCompleted && <Check size={16} color="#28a745" />}
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        <div className="main-header">
          <div className="header-top">
            <h1>To-dos {selectedProjectId && `- ${projects.find(p => p.id === selectedProjectId)?.name}`}</h1>
            <div style={{ position: 'relative' }}>
              <MoreVertical 
                size={20} 
                color="var(--text-gray)" 
                style={{ cursor: 'pointer' }} 
                onClick={() => setIsMenuOpen(!isMenuOpen)}
              />
              {isMenuOpen && (
                <div style={{ 
                  position: 'absolute', 
                  right: 0, 
                  top: '100%', 
                  marginTop: '8px', 
                  backgroundColor: 'white', 
                  border: '1px solid var(--border-color)', 
                  borderRadius: '6px', 
                  boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                  zIndex: 100,
                  minWidth: '200px'
                }}>
                  <div 
                    onClick={async () => {
                      if (token) {
                        const url = `https://gc-pro.vercel.app/login?token=${token}`;
                        try {
                          await openUrl(url);
                        } catch (e) {
                          console.error("Failed to use openUrl:", e);
                          // Fallback
                          window.open(url, '_blank');
                        }
                      } else {
                        alert("Session token is missing. Please log in again.");
                      }
                      setIsMenuOpen(false);
                    }}
                    style={{ 
                      padding: '12px 16px', 
                      cursor: 'pointer', 
                      fontSize: '13px', 
                      fontWeight: 500,
                      color: 'var(--primary-blue)'
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#f1f3f4')}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                  >
                    Open Web Dashboard
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="header-subtitle">
            {userRole}
          </div>

          <div className="filters-row">
            <label className="filter-checkbox">
              <input type="checkbox" />
              Show completed
            </label>
          </div>

          {canCreate && (
            <div className="create-todo-row">
              <input type="text" placeholder="Create a to-do" />
              <button className="add-btn">
                <Plus size={18} />
              </button>
            </div>
          )}
        </div>

        <div className="todo-list-container">
          <table className="todo-table">
            <thead>
              <tr>
                <th>To-do</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {displayedTasks.map(task => {
                const isSelected = selectedTaskId === task.id;
                
                let rowClass = "todo-row";
                if (isSelected) rowClass += " active";
                
                let rowStyle = {};
                if (task.isCompleted) {
                  rowStyle = { backgroundColor: '#d4edda', color: '#155724' };
                }

                return (
                  <tr 
                    key={task.id} 
                    className={rowClass}
                    style={rowStyle}
                    onClick={() => {
                      const proj = projects.find(p => p.tasks.some(t => t.id === task.id));
                      if (proj) handleTaskClick(task.id, proj.id);
                    }}
                  >
                    <td className="todo-title-cell">
                      {task.isCompleted ? (
                        <Check size={16} color="#28a745" style={{ marginLeft: isSelected ? 0 : 16 }} />
                      ) : isSelected ? (
                        isPlaying ? (
                          <Pause 
                            size={16} 
                            fill="var(--primary-blue)" 
                            className="play-icon" 
                            style={{ color: 'var(--primary-blue)', cursor: 'pointer' }} 
                            onClick={(e) => { e.stopPropagation(); stopBackendTimer(); }}
                          />
                        ) : (
                          <Play 
                            size={16} 
                            fill="var(--primary-blue)" 
                            className="play-icon" 
                            style={{ color: 'var(--primary-blue)', cursor: 'pointer' }} 
                            onClick={(e) => { e.stopPropagation(); startBackendTimer(task.id); }}
                          />
                        )
                      ) : (
                        <div style={{ width: 16, height: 16, marginLeft: 16 }}></div>
                      )}
                      <span style={{ textDecoration: task.isCompleted ? 'line-through' : 'none' }}>
                        {task.name}
                      </span>
                    </td>
                    <td>{task.created}</td>
                  </tr>
                );
              })}
              {displayedTasks.length === 0 && (
                <tr>
                  <td colSpan={2} style={{ textAlign: 'center', color: 'var(--text-gray)', padding: '20px' }}>No tasks found.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="todo-details-pane">
          <div className="details-header">
            <h3>{activeTask ? activeTask.name : 'Select a task'}</h3>
            <div className="details-actions">
              {activeTask && !activeTask.isCompleted && (
                <button className="btn-complete" onClick={handleCompleteTask}>
                  Complete
                </button>
              )}
              {activeTask && activeTask.isCompleted && (
                <button className="btn-complete" style={{ backgroundColor: '#28a745', color: 'white', borderColor: '#28a745', cursor: 'default' }}>
                  Completed
                </button>
              )}
              <MoreVertical size={20} color="var(--text-gray)" style={{ cursor: 'pointer' }} />
            </div>
          </div>
          <div className="details-meta">
            {activeTask ? `Changed: ${activeTask.created}` : ''}
          </div>
          <div className="details-description">
            No description
          </div>
        </div>

      </main>
      
      {/* Absolute positioned Status Bar at the bottom across main area */}
      <div className="status-bar" style={{ position: 'absolute', bottom: 0, right: 0, left: 'var(--sidebar-width)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <RefreshCw size={14} />
          Last updated at: {lastProjectCompletedAt ? lastProjectCompletedAt.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '06/27/2024 09:46 AM'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ display: 'flex', border: '1px solid var(--border-color)', borderRadius: '4px', overflow: 'hidden' }}>
             <div style={{ padding: '2px 4px', borderRight: '1px solid var(--border-color)', cursor: 'pointer' }}><ChevronLeft size={14} /></div>
             <div style={{ padding: '2px 4px', cursor: 'pointer' }}><ChevronRight size={14} /></div>
          </div>
          Showing {displayedTasks.length} of {displayedTasks.length} to-dos
        </div>
      </div>
    </div>
  );
}

export default App;
