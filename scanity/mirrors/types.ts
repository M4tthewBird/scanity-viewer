// A mirror portal as exported by the Splat Portal Mirror Tool's "Export
// mirrors.json" button (see /splat-portal-mirror-tool). Position/rotation are
// world-space; rotation is a quaternion (x, y, z, w) to avoid Euler ambiguity
// and round-trip straight into Entity.setRotation(). radius is the full
// width for "rect", the cap radius for "capsule", or the radius for "circle".
// height is the full height for rect/capsule, null for circle.
type MirrorShape = 'circle' | 'rect' | 'capsule';

type MirrorConfig = {
    shape: MirrorShape;
    position: [number, number, number];
    rotation: [number, number, number, number];
    scale: [number, number, number];
    radius: number;
    height: number | null;
    cullFront: number;
    cullBack: number;
    enabled: boolean;
};

export type { MirrorConfig, MirrorShape };
