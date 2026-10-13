-- Optional BACB task list section per entry (BCBA Test Content Outline, 6th ed., sections A–I),
-- and a trainee's own monthly hours goal (a personal target; BACB requirements are checked separately).
alter table entries add column task_area char(1) check (task_area between 'A' and 'I');
alter table users add column monthly_goal_minutes integer check (monthly_goal_minutes between 1200 and 9600);
grant update (monthly_goal_minutes) on users to fieldtrack_app;
