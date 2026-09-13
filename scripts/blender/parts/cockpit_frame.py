"""
The helm's shared frame: the dash face plane every cockpit part is laid out on (anchors.dash + well).

Face coordinates: u across (+x = pilot's left, the pilot faces +z), v up the face from its bottom
edge, off = along the face normal toward the pilot's eye. The face leans back 18° so it looks up at
the eye (anchors.eye, sheer + 0.50).
"""
import math

from mathutils import Matrix, Vector


class Face:
    def __init__(self, A):
        D = A.dash()
        W = A.cockpit_well()
        self.A = A
        self.D = D
        self.W = W
        self.top = Vector((0.0, D['topY'] - 0.02, D['zAft'] + 0.08))
        self.bottom = Vector((0.0, W['soleY'] + 0.33, D['zAft'] - 0.04))
        self.v = (self.top - self.bottom).normalized()
        self.height = (self.top - self.bottom).length
        self.u = Vector((1.0, 0.0, 0.0))
        self.n = self.v.cross(self.u).normalized()  # aft-up, toward the eye

    def at(self, u, v, off=0.0):
        return self.bottom + self.u * u + self.v * v + self.n * off

    def matrix(self, u, v, off=0.0, spin_deg=0.0):
        """proper frame: local x = the pilot's right (−u), local y = up the face (v), local z = the face
        normal toward the pilot. Text authored along +x reads left-to-right from the seat."""
        o = self.at(u, v, off)
        M = Matrix.Identity(4)
        c, s = math.cos(math.radians(spin_deg)), math.sin(math.radians(spin_deg))
        x = -self.u * c + self.v * s
        y = self.u * s + self.v * c
        for r in range(3):
            M[r][0], M[r][1], M[r][2], M[r][3] = x[r], y[r], self.n[r], o[r]
        return M
