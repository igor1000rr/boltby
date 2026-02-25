import { memo, useMemo } from 'react';
import styles from './styles.module.scss';

const PARTICLE_COUNT = 15;

const BackgroundRays = memo(() => {
  const particles = useMemo(() => {
    return Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
      id: i,
      left: `${(i * 7.3 + 3) % 100}%`,
      delay: `${(i * 1.7) % 10}s`,
      duration: `${6 + (i % 5) * 2}s`,
      size: `${2 + (i % 3)}px`,
    }));
  }, []);

  return (
    <div className={styles.rayContainer}>
      <div className={`${styles.lightRay} ${styles.ray1}`} />
      <div className={`${styles.lightRay} ${styles.ray2}`} />
      <div className={`${styles.lightRay} ${styles.ray3}`} />
      <div className={`${styles.lightRay} ${styles.ray4}`} />
      <div className={`${styles.lightRay} ${styles.ray5}`} />
      <div className={`${styles.lightRay} ${styles.ray6}`} />
      <div className={`${styles.lightRay} ${styles.ray7}`} />
      <div className={`${styles.lightRay} ${styles.ray8}`} />
      {particles.map((p) => (
        <span
          key={p.id}
          className={styles.particle}
          style={{
            left: p.left,
            animationDelay: p.delay,
            animationDuration: p.duration,
            width: p.size,
            height: p.size,
          }}
        />
      ))}
    </div>
  );
});

export default BackgroundRays;
