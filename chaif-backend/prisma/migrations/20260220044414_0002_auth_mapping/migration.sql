/*
  Warnings:

  - Made the column `authProvider` on table `User` required. This step will fail if there are existing NULL values in that column.
  - Made the column `authSubject` on table `User` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL,
ALTER COLUMN "authProvider" SET NOT NULL,
ALTER COLUMN "authSubject" SET NOT NULL;
