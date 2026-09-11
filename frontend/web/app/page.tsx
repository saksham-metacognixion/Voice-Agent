import { Button } from '@portal/ui';

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-start justify-center gap-4 p-8">
      <h1 className="text-3xl font-semibold">Voice Agent Portal</h1>
      <p className="text-neutral-600">
        Build, test and publish an AI phone agent in under 15 minutes.
      </p>
      <p className="text-sm text-neutral-500">
        Scaffold only. Screens land per the plan in <code>docs/plan/tasks.csv</code>.
      </p>
      <Button>It renders</Button>
    </main>
  );
}
