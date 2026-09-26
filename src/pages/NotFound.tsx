import { motion } from "framer-motion";
import { Link } from "react-router";

export default function NotFound() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      className="relative flex min-h-screen flex-col items-center justify-center bg-background px-6 text-foreground"
    >
      <div className="absolute inset-0 bg-grid [mask-image:radial-gradient(60%_50%_at_50%_40%,black,transparent)]" />
      <div className="relative text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
          404 · resource not found
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">
          Nothing is listening at this route
        </h1>
        <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">
          The console does not serve a page here. Head back to the fleet
          overview and pick up where you left off.
        </p>
        <Link
          to="/console"
          className="mt-7 inline-flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 text-[13px] font-medium text-primary transition-colors hover:bg-primary/15"
        >
          Go to console
        </Link>
      </div>
    </motion.div>
  );
}
