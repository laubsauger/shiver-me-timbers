# ENGINEERING SPECIFICATION & HANDOFF: CHARACTER MOVEMENT & GROUND CONTACT SYSTEM

## 1. OBJECTIVE
Implement a robust WASD + Mouse character controller featuring Mixamo animations that completely eliminates foot sliding ("ice skating") and provides clean, smooth foot placement (Inverse Kinematics) when navigating uneven terrain, ramps, and stairs.

---

## 2. PART 1: ELIMINATING FOOT SLIDING (ICE SKATING)

### 2.1 Core Strategy: In-Place Animations + Dynamic Code Blending
To prevent the mesh from moving independently of the animation speed, all movement animations must be processed **In-Place**. The JavaScript application loop drives world position (translation), while the system dynamically blends weights and scales animation playback speeds (`timeScale`) relative to the character's real-time velocity.

### 2.2 Asset Requirements
* **Idle, Walk, Run Clips:** Must be acquired with the **In Place** flag enabled during the Mixamo export process.
* **Rigging Note:** Ensure bone hierarchies preserve the standard Mixamo naming conventions (`mixamorigHips`, `mixamorigLeftFoot`, etc.) to streamline joint targeting.

### 2.3 Reference Implementation: Blending & Time-Scaling Loop
```javascript
// Initialization State
const mixer = new THREE.AnimationMixer(characterMesh);
const idleAction = mixer.clipAction(idleClip);
const walkAction = mixer.clipAction(walkClip);
const runAction = mixer.clipAction(runClip);

// Initialize all tracks concurrently to avoid clipping on transition
[idleAction, walkAction, runAction].forEach(action => {
  action.play();
  action.setEffectiveWeight(0.0);
});
idleAction.setEffectiveWeight(1.0);

const WALK_SPEED = 2.5; // Ideal velocity matching the walking clip stride
const RUN_SPEED = 6.0;  // Ideal velocity matching the running clip stride
let currentSpeed = 0.0;

function updateAnimationState(delta, isMoving, isRunningIntent) {
  // Determine target velocity based on input flags
  const targetSpeed = isMoving ? (isRunningIntent ? RUN_SPEED : WALK_SPEED) : 0.0;
  
  // Smoothly interpolate current velocity to prevent animation snapping
  currentSpeed = THREE.MathUtils.lerp(currentSpeed, targetSpeed, delta * 10);

  // 1. Calculate Blend Weights
  let idleWeight = 0, walkWeight = 0, runWeight = 0;

  if (currentSpeed <= WALK_SPEED) {
    const ratio = currentSpeed / WALK_SPEED;
    walkWeight = ratio;
    idleWeight = 1.0 - ratio;
  } else {
    const ratio = (currentSpeed - WALK_SPEED) / (RUN_SPEED - WALK_SPEED);
    runWeight = ratio;
    walkWeight = 1.0 - ratio;
  }

  idleAction.setEffectiveWeight(idleWeight);
  walkAction.setEffectiveWeight(walkWeight);
  runAction.setEffectiveWeight(runWeight);

  // 2. Adjust TimeScale (The Anti-Ice Skating Mechanism)
  if (currentSpeed > 0) {
    if (currentSpeed <= WALK_SPEED) {
      // Scale playback linearly based on deviation from ideal walk speed
      walkAction.timeScale = currentSpeed / WALK_SPEED;
    } else {
      // Scale playback linearly based on deviation from ideal run speed
      runAction.timeScale = currentSpeed / RUN_SPEED;
      walkAction.timeScale = 1.0; 
    }
  }

  mixer.update(delta);
}
```

---

## 3. PART 2: GROUND CONTACT, STAIRS, & INVERSE KINEMATICS (IK)

### 3.1 Step Offset & Capsule Collision
To walk up stairs cleanly, the root character body must be represented by an invisible vertical capsule collider. The collision system must support a **Step Offset** configuration (recommended: `0.3m`). 
* When moving into low-profile geometry (stairs/ledges), the physical collider must smoothly glide upward like a ramp.
* The physical system updates the overall `characterMesh.position`.

### 3.2 Dynamic Inverse Kinematics (IK)
To prevent feet from floating or sinking into uneven surfaces, use an IK solver (e.g., `three-ik` or the built-in `CCDIKSolver`) to manually ground the ankle joints.

```
       [Hips] ---> Compensates height based on average leg compression
       /    \
   [Thigh]  [Thigh]
     |        |
   [Shin]   [Shin]
     |        |
  [Ankle]  [Ankle] ---> Solved target via Raycast (Lerped over time)
    ||       ||
======= GROUND LAYER ====================================
```

### 3.3 Mitigation Strategy for Stair Jitter (Smoothing)
1. **Raycast Ahead:** Cast rays downwards from the projected future world position of the feet, slightly before the foot down-strike occurs in the animation cycle.
2. **Target Interpolation (Lerping):** Do not snap the IK target position instantly to the raycast intersection point. Interpolate the target height over time using `THREE.MathUtils.lerp(currentTargetY, hitPointY, delta * 12)`.
3. **Pelvis Compensation:** If a foot is forced upward significantly, the `mixamorigHips` bone position must be lowered or tilted dynamically relative to the root mesh to prevent overextension or impossible bone compression.

---

## 4. ASSIGNMENT FOR THE IMPLEMENTATION AGENT

Please evaluate the current application architecture and execute the implementation based on the following stack assessment protocol:

### Step 1: Detect and Audit Current Physics Stack
Inspect the source codebase to determine how environment collisions are handled. Identify which pattern our project currently uses:
* **Scenario A: Built-in Physics Engine Active** (e.g., Rapier, Cannon.js, Ammo.js).
  * *Action:* Utilize the engine’s native Character Controller API. Ensure a **Capsule Collider** is instantiated for the player, and explicitly configure the `stepOffset` property (typically `0.3` units) to handle stair navigation natively.
* **Scenario B: Custom Octree / BVH Collision** (e.g., `three-mesh-bvh` or standard Three.js Octree demo utils).
  * *Action:* Leverage the existing capsule-to-triangle intersection loops. Modify the displacement logic to allow a threshold where horizontal impacts below `0.3m` automatically translate the player vertically.
* **Scenario C: No Collision Framework Present.**
  * *Action:* Integrate a simple lightweight capsule system. It is highly recommended to implement `three-mesh-bvh` for performant environment raycasting and basic capsule collision boundaries without overhead.

### Step 2: Choose and Configure the IK Engine
Determine the best path to bind foot joints to the terrain geometry:
* **Option A:** Utilize standard programmatic joint rotation if a lightweight solution is needed for shallow slopes (manually offsetting foot bone matrices based on raycast differentials).
* **Option B:** Integrate `three-ik` or configure `CCDIKSolver` if full multi-joint leg bending (hip-knee-ankle constraints) is required for realistic high-step stair climbing.

### Step 3: Implement & Validate
1. Set up the WASD + Mouse input listeners.
2. Integrate the **TimeScale / Speed matching algorithm** defined in section 2.3.
3. Wire the raycast positions to the IK targets using the smoothing lerp calculations to ensure stability over stepped surfaces.
