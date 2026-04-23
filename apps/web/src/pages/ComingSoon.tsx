interface ComingSoonProps {
  page: string;
}

export function ComingSoon({ page }: ComingSoonProps) {
  return (
    <div className="flex items-center justify-center min-h-[400px]">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-white mb-2">{page}</h1>
        <p className="text-zinc-400">Coming soon...</p>
      </div>
    </div>
  );
}
