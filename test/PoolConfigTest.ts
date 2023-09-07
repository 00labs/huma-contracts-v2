import { ethers } from "hardhat";

let mockToken;
let poolConfig;

describe("PoolConfig Test", function () {
    before(async function () {
        await ethers.getSigners();

        const MockToken = await ethers.getContractFactory("MockToken");
        mockToken = await MockToken.deploy();
        await mockToken.waitForDeployment();

        const PoolConfig = await ethers.getContractFactory("PoolConfig");
        poolConfig = await PoolConfig.deploy();
        await poolConfig.waitForDeployment();
    });
});
