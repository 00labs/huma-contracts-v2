const {network} = require("hardhat");

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
    setNextBlockTimestamp,
    mineNextBlockWithTimestamp,
};
