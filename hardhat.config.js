require("hardhat-contract-sizer");
require("hardhat-gas-reporter");

require("@nomiclabs/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");

module.exports = {
    solidity: {
        compilers: [
            {
                version: "0.8.18",
                settings: {
                    optimizer: {
                        enabled: true,
                        runs: 200,
                    },
                },
            },
        ],
    },
    contractSizer: {
        alphaSort: true,
        disambiguatePaths: false,
        runOnCompile: true,
        strict: true,
    },

    /**
     * gas reporter configuration that let's you know
     * an estimate of gas for contract deployments and function calls
     * More here: https://hardhat.org/plugins/hardhat-gas-reporter.html
     */
    gasReporter: {
        currency: "USD",
        coinmarketcap: process.env.COINMARKETCAP || null,
    },
};
