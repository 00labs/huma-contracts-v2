const {ethers} = require("hardhat");
const {expect} = require("chai");

let mockToken;
let poolConfig;

describe("Pool Config", function () {
    before(async function () {
        [defaultDeployer] = await ethers.getSigners();

        const MockToken = await ethers.getContractFactory("MockToken");
        mockToken = await MockToken.deploy();
        await mockToken.deployed();

        const PoolConfig = await ethers.getContractFactory("PoolConfig");
        poolConfig = await PoolConfig.deploy();
        await poolConfig.deployed();
    });

    it("setAsset", async function () {
        expect(await poolConfig.asset()).to.equal(ethers.constants.AddressZero);
        await poolConfig.setAsset(mockToken.address);
        expect(await poolConfig.asset()).to.equal(mockToken.address);
    });
});
