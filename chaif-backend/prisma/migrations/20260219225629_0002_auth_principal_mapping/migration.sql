/*
  Warnings:

  - A unique constraint covering the columns `[authProvider,authSubject]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "authProvider" TEXT,
ADD COLUMN     "authSubject" TEXT,
ADD COLUMN     "memberRef" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_authProvider_authSubject_key" ON "User"("authProvider", "authSubject");
