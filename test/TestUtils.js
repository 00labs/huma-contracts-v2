const {network} = require("hardhat");
const {BigNumber: BN} = require("ethers");

function toBN(number, decimals) {
    return BN.from(number).mul(BN.from(10).pow(BN.from(decimals)));
}

function toToken(number, decimals = 6) {
    return toBN(number, decimals);
}

async function setNextBlockTimestamp(nextTS) {
    await network.provider.request({
        method: "evm_setNextBlockTimestamp",
        params: [nextTS],
    });
}

async function mineNextBlockWithTimestamp(nextTS) {
    await network.provider.request({
        method: "evm_setNextBlockTimestamp",
        params: [nextTS],
    });
    await network.provider.send("evm_mine", []);
}

module.exports = {
    toBN,
    toToken,
    setNextBlockTimestamp,
    mineNextBlockWithTimestamp,
};
