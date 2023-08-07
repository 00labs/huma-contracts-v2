const {ethers} = require("hardhat");
const {expect} = require("chai");
const {loadFixture} = require("@nomicfoundation/hardhat-network-helpers");
const {deployContracts, deployAndSetupPool} = require("./BaseTest");

let defaultDeployer;
let protocolOwner;
let treasury;
let eaServiceAccount;
let pdsServiceAccount;
let poolOwner;

describe("TrancheVault", function () {
    before(async function () {
        [
            defaultDeployer,
            protocolOwner,
            treasury,
            eaServiceAccount,
            pdsServiceAccount,
            poolOwner,
        ] = await ethers.getSigners();
    });

    async function prepare() {
        [eaNFTContract, humaConfigContract, mockTokenContract] = await deployContracts(
            protocolOwner,
            treasury,
            eaServiceAccount,
            pdsServiceAccount,
            poolOwner
        );
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });
});
