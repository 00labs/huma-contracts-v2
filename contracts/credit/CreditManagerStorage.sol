// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {HumaConfig} from "../common/HumaConfig.sol";
import {CreditConfig} from "./CreditStructs.sol";
import {ICredit} from "./interfaces/ICredit.sol";
import {ICalendar} from "../common/interfaces/ICalendar.sol";
import {ICreditDueManager} from "./interfaces/ICreditDueManager.sol";
import {IPool} from "../liquidity/interfaces/IPool.sol";

contract CreditManagerStorage {
    HumaConfig public humaConfig;
    IPool public pool;
    ICredit public credit;
    ICalendar public calendar;
    ICreditDueManager public dueManager;

    /// Mapping from credit id to the credit config.
    mapping(bytes32 => CreditConfig) internal _creditConfigMap;

    /// Mapping from credit hash to the borrower.
    mapping(bytes32 => address) internal _creditBorrowerMap;

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[100] private __gap;
}
