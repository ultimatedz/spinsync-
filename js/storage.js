const PROFILE_KEY = 'spinsync_profile';
const WORKOUTS_KEY = 'spinsync_workouts';

const DEFAULT_PROFILE = {
  name: 'Caio',
  age: 28,
  weight: 103,
  sex: 'M',
  restingHR: 70
};

export function getProfile() {
  const data = localStorage.getItem(PROFILE_KEY);
  return data ? JSON.parse(data) : null;
}

export function saveProfile(profile) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

export function getDefaultProfile() {
  return { ...DEFAULT_PROFILE };
}

export function getWorkouts() {
  const data = localStorage.getItem(WORKOUTS_KEY);
  return data ? JSON.parse(data) : [];
}

export function saveWorkout(workout) {
  const workouts = getWorkouts();
  workouts.unshift(workout);
  localStorage.setItem(WORKOUTS_KEY, JSON.stringify(workouts));
}

export function getWorkoutById(id) {
  const workouts = getWorkouts();
  return workouts.find(w => w.id === id) || null;
}

export function deleteWorkout(id) {
  const workouts = getWorkouts().filter(w => w.id !== id);
  localStorage.setItem(WORKOUTS_KEY, JSON.stringify(workouts));
}
