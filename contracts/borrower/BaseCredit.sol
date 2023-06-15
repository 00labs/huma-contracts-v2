// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {DealConfig} from "../DealStructs.sol";
import {IDealPortfolioPool} from "../interfaces/IDealPortfolioPool.sol";

struct CreditLimit {
    address borrower; // loan borrower address
    uint96 creditLimit; // the max borrowed amount
}

contract BaseCredit {
    mapping(bytes32 => CreditLimit) public creditLimits;

    IDealPortfolioPool public pool;

    function _approve(
        bytes32 creditHash,
        address borrower,
        uint256 creditLimit,
        DealConfig calldata dealConfig
    ) internal {
        // only EA

        CreditLimit memory cl = creditLimits[creditHash];
        if (cl.borrower != address(0)) revert();

        pool.createDealConfig(creditHash, dealConfig);
    }

    function drawdown(bytes32 creditHash, uint256 borrowAmount) public virtual {
        // only borrower or approved address borrower

        CreditLimit memory cl = creditLimits[creditHash];

        pool.borrowFromDeal(creditHash, borrowAmount);

        // transfer borrowAmount to borrower
    }

    function makePayment(
        bytes32 creditHash,
        uint256 amount
    ) public virtual returns (uint256 amountPaid, bool paidoff) {
        CreditLimit memory cl = creditLimits[creditHash];

        pool.payToDeal(creditHash, amount);

        // transfer amount from msg.sender
    }
}
