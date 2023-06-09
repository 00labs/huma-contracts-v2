// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {DealConfig} from "./DealStructs.sol";

import {IDealManager} from "./interfaces/IDealManager.sol";
import {IReserve} from "./interfaces/IReserve.sol";
import {IDealPortfolioPool} from "./interfaces/IDealPortfolioPool.sol";

struct DealLimit {
    bytes32 dealHash;
    address borrower;
    uint96 dealLimit;
}

contract DealManager is IDealManager {
    mapping(bytes32 => DealLimit) public dealLimits;
    address public receivableManager;

    IReserve public reserve;
    IDealPortfolioPool public portfolioPool;

    function approveDeal(
        bytes32 dealHash,
        address borrower,
        uint256 dealLimit,
        DealConfig calldata dealConfig
    ) external override {
        _onlyReceivableManager();

        // check parameters

        // create & store deal limit

        portfolioPool.createDealConfig(dealHash, dealConfig);
    }

    function drawdown(bytes32 dealHash, uint256 borrowAmount) external override {
        _onlyReceivableManager();

        DealLimit memory dl = dealLimits[dealHash];
        // check current deal state
        portfolioPool.borrowFromDeal(dealHash, borrowAmount);
        reserve.withdraw(dl.borrower, borrowAmount);
    }

    function makePayment(bytes32 dealHash, uint256 amount) external override {
        // check current deal state
        portfolioPool.payToDeal(dealHash, amount);
        reserve.deposit(msg.sender, amount);
    }

    function _onlyReceivableManager() internal view {
        if (msg.sender != receivableManager) revert();
    }
}
