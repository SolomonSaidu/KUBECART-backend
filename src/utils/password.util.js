import argon2 from 'argon2';

export const passwordUtil = {
  async hashPassword(password) {
    return argon2.hash(password, {
      type: argon2.argon2id,
    });
  },

  async verifyPassword(hashedPassword, plainPassword) {
    return argon2.verify(hashedPassword, plainPassword);
  },
};
