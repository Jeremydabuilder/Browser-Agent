// Google Classroom (read-only): turns your coursework into Satchel assignments.
import { googleFetch } from './google-auth.js';
import { uid, ymd, pad2 } from './util.js';

const API = 'https://classroom.googleapis.com/v1';

/** Classroom due dates are in UTC; convert to the student's local date/time. */
export function classroomDue(dueDate, dueTime) {
  if (!dueDate?.year) return { date: null, time: null, status: 'missing', note: 'No due date in Google Classroom.', raw: '' };
  if (!dueTime || (dueTime.hours === undefined && dueTime.minutes === undefined)) {
    return { date: `${dueDate.year}-${pad2(dueDate.month)}-${pad2(dueDate.day)}`, time: null, status: 'exact', note: 'From Google Classroom.', raw: '' };
  }
  const d = new Date(Date.UTC(dueDate.year, dueDate.month - 1, dueDate.day, dueTime.hours || 0, dueTime.minutes || 0));
  return { date: ymd(d), time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`, status: 'exact', note: 'From Google Classroom.', raw: '' };
}

export function courseWorkToAssignment(work, course, submission, now = new Date()) {
  const done = submission && ['TURNED_IN', 'RETURNED'].includes(submission.state);
  const link = work.alternateLink || course.alternateLink || 'https://classroom.google.com/';
  return {
    id: uid('asg'),
    title: String(work.title || 'Untitled').slice(0, 250),
    className: String(course.name || '').slice(0, 120),
    classGuessed: false,
    instructions: String(work.description || '').slice(0, 2000),
    notes: '',
    due: classroomDue(work.dueDate, work.dueTime),
    sourceUrl: link,
    sources: [{ pageUrl: 'https://classroom.google.com/', itemUrl: link, label: 'Google Classroom', seenAt: now.toISOString() }],
    status: done ? 'done' : 'open',
    origin: 'classroom',
    edited: {},
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    isNew: true,
  };
}

async function paged(url, key) {
  const items = [];
  let pageToken = '';
  for (let i = 0; i < 5; i++) {
    const r = await googleFetch('classroom', `${url}${url.includes('?') ? '&' : '?'}pageSize=100${pageToken ? `&pageToken=${pageToken}` : ''}`, { label: 'Google Classroom' });
    items.push(...(r[key] || []));
    if (!r.nextPageToken) break;
    pageToken = encodeURIComponent(r.nextPageToken);
  }
  return items;
}

export async function importClassroom(now = new Date()) {
  const courses = await paged(`${API}/courses?courseStates=ACTIVE&studentId=me`, 'courses');
  const out = [];
  const problems = [];
  for (const course of courses) {
    try {
      const [work, subs] = await Promise.all([
        paged(`${API}/courses/${course.id}/courseWork?orderBy=dueDate%20desc`, 'courseWork'),
        paged(`${API}/courses/${course.id}/courseWork/-/studentSubmissions?userId=me`, 'studentSubmissions').catch(() => []),
      ]);
      const byWork = new Map(subs.map((s) => [s.courseWorkId, s]));
      for (const w of work) out.push(courseWorkToAssignment(w, course, byWork.get(w.id), now));
    } catch (err) {
      problems.push(`${course.name}: ${err.message}`);
    }
  }
  return { assignments: out, courseCount: courses.length, problems };
}
