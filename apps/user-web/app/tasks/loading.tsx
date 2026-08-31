export default function TasksLoading() {
  return (
    <div className="task-loading" role="status" aria-live="polite">
      <span aria-hidden="true" />
      正在安全加载任务…
    </div>
  );
}
